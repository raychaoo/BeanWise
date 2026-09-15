/**
 * M8 report 域 IPC（T3）。数据源 = SQLite 索引行（SQL 只做行筛选/排序，金额聚合在
 * report-aggregation.ts 用 decimal.ts 精确字符串运算——SQLite SUM 转 REAL 丢精度，禁用）。
 * 运营货币取 ledger_meta.operating_currency[0]；无 option 时按 postings 币种频次兜底识别主币
 * （2026-08-23 回归修复：清空/重建后缺 option 会导致图表按 '' 过滤恒空），再无 → ''（空集）。
 */
import { and, asc, count, desc, eq, gte, inArray, like, lte, max, min, or, type SQL } from 'drizzle-orm'
import type { SaveDialogOptions, WebContents } from 'electron'
import type {
  ExportReportPdfResult,
  ReportBalancesParams,
  ReportBalancesResult,
  ReportBreakdownParams,
  ReportBreakdownResult,
  ReportCashFlowParams,
  ReportCashFlowResult,
  ReportCounterpartyLedgerResult,
  ReportCounterpartyTransactionsParams,
  ReportCounterpartyTransactionsResult,
  ReportGranularity,
  ReportIncomeExpenseParams,
  ReportIncomeExpenseResult,
  ReportNetWorthParams,
  ReportNetWorthResult,
  ReportTrialBalanceParams,
  ReportTrialBalanceResult,
  ReportYearRange,
  ReportYearsResult
} from '../../../shared/ipc'
import type { DrizzleDb } from '../../db/index'
import { entries, postings } from '../../db/schema'
import { getLedgerStatus } from '../../core/index-builder'
import {
  buildAccountTree,
  computeBreakdown,
  computeCashFlow,
  computeCounterpartyFlow,
  computeCounterpartyLedger,
  computeIncomeExpense,
  computeNetWorth,
  computeTrialBalance,
  type CashFlowPostingRow,
  type CounterpartyFlowPostingRow,
  type CounterpartyPostingRow,
  type PostingRow
} from '../../core/report-aggregation'
import { computeLoanLedger, loadLoanRows } from '../../core/loan-links'
import { flattenExpenseTaxonomy } from '../../expenses/expense-taxonomy'
import type { IpcRegistrar } from '../ledger/ipc-handlers'

const EXPENSE_CATEGORY_LABELS = new Map(
  flattenExpenseTaxonomy().map((account) => [account.path, account.label])
)

/** PDF 导出依赖（index.ts 注入真实实现；测试注入 mock——模块不直接 import electron 运行时） */
export interface ReportPdfDeps {
  /** 当前窗口提供者：主进程取 BrowserWindow.getFocusedWindow() ?? getAllWindows()[0] */
  getWindow?: () => { webContents: Pick<WebContents, 'printToPDF'> } | null
  /** 保存对话框（dialog.showSaveDialog；取消 → canceled:true） */
  showSaveDialog?: (options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>
  /** 写 PDF 字节到文件（fs.promises.writeFile） */
  writeFile?: (filePath: string, data: Uint8Array) => Promise<void>
}

export interface ReportDeps extends ReportPdfDeps {
  db: DrizzleDb
  /** 往来类账户路径提供者（ADR 23）：读账户库 counterparty 标志，查询时实时取值
   * （账户库可先于账本变化，快照会读到旧值）。未注入 / 未标记任何账户 → 往来账空集。 */
  counterpartyAccounts?: () => string[]
}

const YEAR_RE = /^\d{4}$/

function validateGranularity(raw: unknown, label: string): ReportGranularity {
  if (raw !== 'day' && raw !== 'week' && raw !== 'month' && raw !== 'year') {
    throw new Error(`${label} 必须是 day/week/month/year`)
  }
  return raw
}

function validateYear(raw: unknown, label: string): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !YEAR_RE.test(String(raw))) {
    throw new Error(`${label} 必须是 4 位数字年份`)
  }
  return raw
}

/** 解析起止年并校验（startYear > endYear 拒绝） */
function validateYearRange(raw: unknown): ReportYearRange {
  const p = (raw ?? {}) as Partial<ReportYearRange>
  const startYear = validateYear(p.startYear, 'startYear')
  const endYear = validateYear(p.endYear, 'endYear')
  if (startYear !== undefined && endYear !== undefined && startYear > endYear) {
    throw new Error('startYear 不能大于 endYear')
  }
  return { startYear, endYear }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 解析 YYYY-MM-DD 日期（缺省 undefined）；非法 → throw */
function validateDate(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw)) throw new Error(`${label} 必须是 YYYY-MM-DD 日期`)
  return raw
}

/** 解析往来对象（显式 string | null；string 须非空且 ≤200 字——同 listEntries 的 account 上限） */
function validateCounterparty(raw: unknown): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) {
    throw new Error('counterparty 必须是不超过 200 字的非空字符串或 null')
  }
  return raw
}

/** 解析币种（非空、≤24 字符——同 AddEntryPosting.currency 上限） */
function validateCurrency(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 24) {
    throw new Error('currency 必须是不超过 24 字的非空字符串')
  }
  return raw
}

/** 解析分页参数（limit 缺省 20、上限 200；offset 缺省 0）——展开面板按页取数，不走全量 */
function validatePaging(raw: { limit?: unknown; offset?: unknown }): { limit: number; offset: number } {
  const limit = raw.limit === undefined ? 20 : raw.limit
  const offset = raw.offset === undefined ? 0 : raw.offset
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('limit 必须是 1..200 的整数')
  }
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new Error('offset 必须是不小于 0 的整数')
  }
  return { limit, offset }
}

/**
 * 加载 postings 行（join entries 取日期，按日期升序——累计口径依赖行序）。
 * where 传 SQL 表达式或 undefined（全量）：drizzle 实测 or(like, like) 与 like(..., '%')
 * 均不匹配 Parameters<typeof like>[1]（string | SQLWrapper），统一收窄为 SQL | undefined
 * （简报 Step 3 预留的兜底方案，行为不变）。
 */
function loadRows(db: DrizzleDb, where: SQL | undefined): PostingRow[] {
  return db
    .select({
      entryId: entries.id,
      date: entries.date,
      account: postings.account,
      number: postings.unitsNumber,
      currency: postings.unitsCurrency,
      counterparty: postings.counterparty
    })
    .from(postings)
    .innerJoin(entries, eq(postings.entryId, entries.id))
    .where(where)
    .orderBy(asc(entries.date), asc(postings.id))
    .all()
}

/**
 * 往来账流水行（ADR 23 展开下钻）：按「往来类账户」过滤，比 loadRows 多取
 * entries.payee/narration（流水需展示交易对象与说明）。独立 loader 而非给共享 PostingRow
 * 加可选字段——同 loadLoanRows 先例。
 */
function loadFlowRows(db: DrizzleDb, accounts: readonly string[]): CounterpartyFlowPostingRow[] {
  if (accounts.length === 0) return []
  return db
    .select({
      entryId: entries.id,
      date: entries.date,
      account: postings.account,
      number: postings.unitsNumber,
      currency: postings.unitsCurrency,
      counterparty: postings.counterparty,
      payee: entries.payee,
      narration: entries.narration
    })
    .from(postings)
    .innerJoin(entries, eq(postings.entryId, entries.id))
    .where(inArray(postings.account, accounts))
    .orderBy(asc(entries.date), asc(postings.id))
    .all()
}

/**
 * 运营货币（主币）。优先取 option operating_currency；无 option 时按 postings 币种出现
 * 频次兜底识别主币（趋势/收支图按运营货币过滤，缺失会恒空——2026-08-23 回归修复）；
 * 两者皆无 → ''（聚合结果为空集）。
 */
function operatingCurrency(db: DrizzleDb): string {
  const configured = getLedgerStatus(db)?.operatingCurrency[0]
  if (configured) return configured
  const top = db
    .select({ currency: postings.unitsCurrency, n: count() })
    .from(postings)
    .groupBy(postings.unitsCurrency)
    .orderBy(desc(count()))
    .limit(1)
    .get()
  return top?.currency ?? ''
}

export function registerReportHandlers(ipc: IpcRegistrar, deps: ReportDeps): void {
  // 注意：db 必须惰性读取（deps.db 为 getter）——工作目录在启动后激活，注册时快照会拿到
  // null/旧连接（2026-08-23 E2E 复现修复，与 ledger 域 registerLedgerHandlers 同口径）。

  ipc.handle('report:net-worth', async (_event: unknown, raw: unknown): Promise<ReportNetWorthResult> => {
    const db = deps.db
    const params = (raw ?? {}) as ReportNetWorthParams
    const granularity = validateGranularity(params.granularity, 'granularity')
    const { startYear, endYear } = validateYearRange(params)
    const currency = operatingCurrency(db)
    // 净资产为累计口径：截至 endYear 年末的行参与累计（趋势起点前历史保留），
    // 输出点再按 [startYear, endYear] 过滤（computeNetWorth 内部 slice）
    const where = endYear !== undefined ? lte(entries.date, `${endYear}-12-31`) : undefined
    // or() 忽略 undefined 条件：无 endYear 时等价于仅账户前缀过滤
    const rows = loadRows(db, or(like(postings.account, 'Assets:%'), like(postings.account, 'Liabilities:%'), where))
    return { series: computeNetWorth(rows, granularity, currency, { startYear, endYear }), currency }
  })

  ipc.handle('report:balances', async (_event: unknown, raw: unknown): Promise<ReportBalancesResult> => {
    const db = deps.db
    const params = (raw ?? {}) as ReportBalancesParams
    const { endYear } = validateYearRange(params)
    // 余额为「期末快照」：截至 endYear 年末的余额（startYear 不影响点值，仅参与范围校验）
    const where = endYear !== undefined ? lte(entries.date, `${endYear}-12-31`) : undefined
    const rows = loadRows(db, where)
    return { accounts: buildAccountTree(rows) }
  })

  // report:trial-balance：三栏式科目余额表（批次 G #5）。opening 需 dateFrom 前全历史，
  // 故 SQL 仅按 dateTo 封顶（禁 SUM，JS 端 addDecimalStrings 切分区间）；无 dateTo → 全量。
  ipc.handle('report:trial-balance', async (_event: unknown, raw: unknown): Promise<ReportTrialBalanceResult> => {
    const db = deps.db
    const params = (raw ?? {}) as ReportTrialBalanceParams
    const dateFrom = validateDate(params.dateFrom, 'dateFrom')
    const dateTo = validateDate(params.dateTo, 'dateTo')
    if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
      throw new Error('dateFrom 不能大于 dateTo')
    }
    const where = dateTo !== undefined ? lte(entries.date, dateTo) : undefined
    const rows = loadRows(db, where)
    return { rows: computeTrialBalance(rows, { dateFrom, dateTo }) }
  })

  ipc.handle('report:income-expense', async (_event: unknown, raw: unknown): Promise<ReportIncomeExpenseResult> => {
    const db = deps.db
    const params = (raw ?? {}) as ReportIncomeExpenseParams
    const granularity = validateGranularity(params.granularity, 'granularity')
    const { startYear, endYear } = validateYearRange(params)
    const currency = operatingCurrency(db)
    const rows = loadRows(db, or(like(postings.account, 'Income:%'), like(postings.account, 'Expenses:%')))
    let start = startYear
    let end = endYear
    if (granularity === 'month') {
      const years = rows.map((r) => Number(r.date.slice(0, 4)))
      const dataMin = years.length ? Math.min(...years) : new Date().getFullYear()
      const dataMax = years.length ? Math.max(...years) : new Date().getFullYear()
      if (start === undefined && end === undefined) {
        // 兼容旧行为：month 缺省范围 → 最近有数据的年份（单年 12 个月，无数据 → 当年全 0）
        start = dataMax
        end = dataMax
      } else {
        if (start === undefined) start = dataMin
        if (end === undefined) end = dataMax
      }
    }
    return {
      series: computeIncomeExpense(rows, granularity, currency, { startYear: start, endYear: end }),
      currency
    }
  })

  // report:cash-flow（批次 G #7）：口径 = Assets 顶层组全部账户视为资金池（池内互转不计），
  // 按运营货币计（避免多币种混计）；dateFrom/dateTo 参与 SQL 行筛选，期间在纯函数内按
  // day/week/month/year 分组——金额全链路 addDecimalStrings，禁 SQL SUM。
  ipc.handle('report:cash-flow', async (_event: unknown, raw: unknown): Promise<ReportCashFlowResult> => {
    const db = deps.db
    const params = (raw ?? {}) as ReportCashFlowParams
    const granularity = validateGranularity(params.granularity, 'granularity')
    const dateFrom = validateDate(params.dateFrom, 'dateFrom')
    const dateTo = validateDate(params.dateTo, 'dateTo')
    if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
      throw new Error('dateFrom 不能大于 dateTo')
    }
    const currency = operatingCurrency(db)
    const conds: SQL[] = []
    if (dateFrom !== undefined) conds.push(gte(entries.date, dateFrom))
    if (dateTo !== undefined) conds.push(lte(entries.date, dateTo))
    const rows = loadRows(db, conds.length > 0 ? and(...conds) : undefined)
    // loadRows 恒含 entryId（select 显式取 entries.id），此处收窄类型供 computeCashFlow 配对
    return {
      series: computeCashFlow(rows as CashFlowPostingRow[], { granularity, currency, dateFrom, dateTo }),
      currency
    }
  })

  // report:breakdown（总览页支出/收入类别汇总）：顶层段聚合，按金额降序，超出 top 位合并为「其他」。
  ipc.handle('report:breakdown', async (_event: unknown, raw: unknown): Promise<ReportBreakdownResult> => {
    const db = deps.db
    const params = (raw ?? {}) as ReportBreakdownParams
    const flow = params.flow === 'income' ? 'income' : 'expense'
    const dateFrom = validateDate(params.dateFrom, 'dateFrom')
    const dateTo = validateDate(params.dateTo, 'dateTo')
    if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
      throw new Error('dateFrom 不能大于 dateTo')
    }
    const currency = operatingCurrency(db)
    const rows = loadRows(db, or(like(postings.account, 'Expenses:%'), like(postings.account, 'Income:%')))
    return computeBreakdown(rows, {
      flow,
      currency,
      dateFrom,
      dateTo,
      top: params.top,
      categoryLabels: flow === 'expense' ? EXPENSE_CATEGORY_LABELS : undefined
    })
  })

  // report:counterparty-ledger（ADR 23）：往来类账户由账户库 counterparty 标志圈定（不硬编码账户名），
  // 按往来对象聚合净额——谁欠我多少 / 我欠谁多少。未标记任何往来类账户 → 空集（accounts 一并回传，
  // 供 UI 区分「真没有往来」与「还没标记往来账户」两种空）。未标注对象的行单列，不让历史数据静默消失。
  ipc.handle('report:counterparty-ledger', (): ReportCounterpartyLedgerResult => {
    const db = deps.db
    const accounts = deps.counterpartyAccounts?.() ?? []
    if (accounts.length === 0) return { rows: [], loans: [], accounts: [] }
    const rows = loadRows(db, inArray(postings.account, accounts)) as CounterpartyPostingRow[]
    return {
      rows: computeCounterpartyLedger(rows),
      // 逐笔核销明细（P2）：只含带 link 的交易，未回填 link 的历史分录不在此列
      loans: computeLoanLedger(loadLoanRows(db, accounts)),
      accounts
    }
  })

  // report:counterparty-transactions（ADR 23 展开下钻）：某往来对象某币种的逐笔交易流水。
  // 与 report:counterparty-ledger 同口径（同一往来类账户集合 + 同一符号约定），累计余额按
  // 全量升序算出后再切片——分页只切输出，不切累计起点，故每页余额都与主表净额勾稽。
  // 独立成通道而非塞进汇总载荷：展开是少数行才触发的动作，汇总不该背全量流水的传输。
  ipc.handle(
    'report:counterparty-transactions',
    async (_event: unknown, raw: unknown): Promise<ReportCounterpartyTransactionsResult> => {
      const db = deps.db
      const params = (raw ?? {}) as ReportCounterpartyTransactionsParams
      const counterparty = validateCounterparty(params.counterparty)
      const currency = validateCurrency(params.currency)
      const { limit, offset } = validatePaging(params)
      const accounts = deps.counterpartyAccounts?.() ?? []
      if (accounts.length === 0) return { rows: [], total: 0 }
      const all = computeCounterpartyFlow(loadFlowRows(db, accounts), { counterparty, currency })
      return { rows: all.slice(offset, offset + limit), total: all.length }
    }
  )

  // report:export-pdf（批次 G #8）：webContents.printToPDF → dialog.showSaveDialog → writeFile。
  // 打印样式由渲染端 @media print 隔离（隐藏侧栏/Header/工具栏，.page-scroll 高度 auto）。
  ipc.handle('report:export-pdf', async (): Promise<ExportReportPdfResult> => {
    if (!deps.getWindow || !deps.showSaveDialog || !deps.writeFile) {
      return { ok: false, message: 'PDF 导出依赖未注入（主进程配置缺失）' }
    }
    const win = deps.getWindow()
    if (!win) return { ok: false, message: '未找到应用窗口，无法导出 PDF' }
    try {
      const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
      const now = new Date()
      const pad = (n: number): string => String(n).padStart(2, '0')
      const defaultPath = `BeanWise-报表-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.pdf`
      const save = await deps.showSaveDialog({
        defaultPath,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (save.canceled || !save.filePath) return { ok: true }
      await deps.writeFile(save.filePath, data)
      return { ok: true, path: save.filePath }
    } catch (err) {
      return { ok: false, message: String(err) }
    }
  })

  ipc.handle('report:years', (): ReportYearsResult => {
    const db = deps.db
    // 全量年份范围（不随筛选变化，供渲染端年份下拉选项稳定）
    const row = db
      .select({ min: min(entries.date), max: max(entries.date) })
      .from(postings)
      .innerJoin(entries, eq(postings.entryId, entries.id))
      .get()
    return {
      min: row?.min ? Number(String(row.min).slice(0, 4)) : 0,
      max: row?.max ? Number(String(row.max).slice(0, 4)) : 0
    }
  })
}
