/**
 * M8 report 域 IPC（T3）。数据源 = SQLite 索引行（SQL 只做行筛选/排序，金额聚合在
 * report-aggregation.ts 用 decimal.ts 精确字符串运算——SQLite SUM 转 REAL 丢精度，禁用）。
 * 运营货币取 ledger_meta.operating_currency[0]；无 meta → ''（聚合结果为空集）。
 */
import { asc, eq, like, or, type SQL } from 'drizzle-orm'
import type { ReportBalancesResult, ReportGranularity, ReportIncomeExpenseParams, ReportIncomeExpenseResult, ReportNetWorthParams, ReportNetWorthResult } from '../shared/ipc'
import type { DrizzleDb } from './db'
import { entries, postings } from './db/schema'
import { getLedgerStatus } from './index-builder'
import { buildAccountTree, computeIncomeExpense, computeNetWorth, type PostingRow } from './report-aggregation'
import type { IpcRegistrar } from './ipc-handlers'

export interface ReportDeps {
  db: DrizzleDb
}

const YEAR_RE = /^\d{4}$/

function validateGranularity(raw: unknown, label: string): ReportGranularity {
  if (raw !== 'month' && raw !== 'year') throw new Error(`${label} 必须是 month 或 year`)
  return raw
}

function validateYear(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !YEAR_RE.test(String(raw))) {
    throw new Error('year 必须是 4 位数字年份')
  }
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

/** 运营货币（主币）；无 meta → '' */
function operatingCurrency(db: DrizzleDb): string {
  return getLedgerStatus(db)?.operatingCurrency[0] ?? ''
}

export function registerReportHandlers(ipc: IpcRegistrar, deps: ReportDeps): void {
  const { db } = deps

  ipc.handle('report:net-worth', async (_event: unknown, raw: unknown): Promise<ReportNetWorthResult> => {
    const granularity = validateGranularity((raw as ReportNetWorthParams | undefined)?.granularity, 'granularity')
    const currency = operatingCurrency(db)
    const rows = loadRows(db, or(like(postings.account, 'Assets:%'), like(postings.account, 'Liabilities:%')))
    return { series: computeNetWorth(rows, granularity, currency), currency }
  })

  ipc.handle('report:balances', (): ReportBalancesResult => {
    const rows = loadRows(db, undefined)
    return { accounts: buildAccountTree(rows) }
  })

  ipc.handle('report:income-expense', async (_event: unknown, raw: unknown): Promise<ReportIncomeExpenseResult> => {
    const params = (raw ?? {}) as ReportIncomeExpenseParams
    const granularity = validateGranularity(params.granularity, 'granularity')
    const year = validateYear(params.year)
    const currency = operatingCurrency(db)
    const rows = loadRows(db, or(like(postings.account, 'Income:%'), like(postings.account, 'Expenses:%')))
    // month 缺省 year → 最近有数据的年份（rows 为空 → 当年，12 个月全 0）
    // 注意：reduce 初始 0，空 rows 得 0 → 必须用 ||（0 非 nullish，?? 不兜底）
    let resolvedYear = year
    if (granularity === 'month' && resolvedYear === undefined) {
      resolvedYear = rows.reduce((acc, r) => Math.max(acc, Number(r.date.slice(0, 4))), 0)
    }
    return {
      series: computeIncomeExpense(rows, granularity, currency, resolvedYear || new Date().getFullYear()),
      currency
    }
  })
}
