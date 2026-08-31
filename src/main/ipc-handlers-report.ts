/**
 * M8 report 域 IPC（T3）。数据源 = SQLite 索引行（SQL 只做行筛选/排序，金额聚合在
 * report-aggregation.ts 用 decimal.ts 精确字符串运算——SQLite SUM 转 REAL 丢精度，禁用）。
 * 运营货币取 ledger_meta.operating_currency[0]；无 option 时按 postings 币种频次兜底识别主币
 * （2026-08-23 回归修复：清空/重建后缺 option 会导致图表按 '' 过滤恒空），再无 → ''（空集）。
 */
import { asc, count, desc, eq, like, lte, max, min, or, type SQL } from 'drizzle-orm'
import type { ReportBalancesParams, ReportBalancesResult, ReportGranularity, ReportIncomeExpenseParams, ReportIncomeExpenseResult, ReportNetWorthParams, ReportNetWorthResult, ReportTrialBalanceParams, ReportTrialBalanceResult, ReportYearRange, ReportYearsResult } from '../shared/ipc'
import type { DrizzleDb } from './db'
import { entries, postings } from './db/schema'
import { getLedgerStatus } from './index-builder'
import { buildAccountTree, computeIncomeExpense, computeNetWorth, computeTrialBalance, type PostingRow } from './report-aggregation'
import type { IpcRegistrar } from './ipc-handlers'

export interface ReportDeps {
  db: DrizzleDb
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

/**
 * 加载 postings 行（join entries 取日期，按日期升序——累计口径依赖行序）。
 * where 传 SQL 表达式或 undefined（全量）：drizzle 实测 or(like, like) 与 like(..., '%')
 * 均不匹配 Parameters<typeof like>[1]（string | SQLWrapper），统一收窄为 SQL | undefined
 * （简报 Step 3 预留的兜底方案，行为不变）。
 */
function loadRows(db: DrizzleDb, where: SQL | undefined): PostingRow[] {
  return db
    .select({
      date: entries.date,
      account: postings.account,
      number: postings.unitsNumber,
      currency: postings.unitsCurrency
    })
    .from(postings)
    .innerJoin(entries, eq(postings.entryId, entries.id))
    .where(where)
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
