/**
 * M8-T3：report 域 handler 测试。内存 SQLite + drizzle 直插 postings/entries 行，
 * 断言 handler 聚合结果与入参校验。金额断言为精确十进制字符串。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDrizzle, openDatabase } from './db'
import { entries, ledgerMeta, postings } from './db/schema'
import { registerReportHandlers, type ReportDeps } from './ipc-handlers-report'

type IpcListener = (channel: string, listener: (...args: unknown[]) => unknown) => void
type Registrar = { handle: ReturnType<typeof vi.fn<IpcListener>> }

function makeRegistrar(): Registrar {
  return { handle: vi.fn<IpcListener>() }
}

/** 组装注册器：抽出已注册 handler，便于直接调用断言 */
// 注意：简报 Step 1 直呼 `listener(params)`（params 落在 event 位）与 Step 3 实现
// `(_event, raw)` 及仓库既有约定（M3 测试：直呼先传 event 占位再传 params）矛盾，
// 按 T2 先例修正测试直呼约定、实现保持逐字——handler 首参是 Electron event。
function register(db: ReportDeps['db']): Map<string, (...args: unknown[]) => Promise<unknown>> {
  const registrar = makeRegistrar()
  registerReportHandlers(registrar, { db })
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  for (const [channel, listener] of registrar.handle.mock.calls as Array<[string, (...args: unknown[]) => Promise<unknown>]>) {
    handlers.set(channel, listener)
  }
  return handlers
}

/** 插入一条 posting（自动补 entries 行——FK on） */
function insertPosting(
  db: ReportDeps['db'],
  row: { date: string; account: string; number: string; currency: string }
): void {
  const entry = db
    .insert(entries)
    .values({ type: 'Transaction', date: row.date, narration: 't' })
    .returning()
    .get()
  db.insert(postings)
    .values({ entryId: entry.id, account: row.account, unitsNumber: row.number, unitsCurrency: row.currency })
    .run()
}

function setup(): { db: ReportDeps['db']; handlers: Map<string, (...args: unknown[]) => Promise<unknown>> } {
  const db = createDrizzle(openDatabase(':memory:'))
  db.insert(ledgerMeta)
    .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '["CNY"]' })
    .run()
  insertPosting(db, { date: '2026-01-05', account: 'Expenses:Food', number: '20.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-01-05', account: 'Liabilities:CreditCard', number: '-20.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-02-01', account: 'Assets:Bank:CNB', number: '10000.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-02-01', account: 'Income:Salary', number: '-10000.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-03-10', account: 'Assets:Bank:USD', number: '100.00', currency: 'USD' })
  return { db, handlers: register(db) }
}

/** 跨年账本（2025 收入/支出 + 2026 信用卡支出），用于起止年筛选断言 */
function setupMultiYear(): { db: ReportDeps['db']; handlers: Map<string, (...args: unknown[]) => Promise<unknown>> } {
  const db = createDrizzle(openDatabase(':memory:'))
  db.insert(ledgerMeta)
    .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '["CNY"]' })
    .run()
  insertPosting(db, { date: '2025-03-01', account: 'Assets:Bank:CNB', number: '10000.00', currency: 'CNY' })
  insertPosting(db, { date: '2025-03-01', account: 'Income:Salary', number: '-10000.00', currency: 'CNY' })
  insertPosting(db, { date: '2025-06-10', account: 'Expenses:Transport', number: '5.00', currency: 'CNY' })
  insertPosting(db, { date: '2025-06-10', account: 'Assets:Bank:CNB', number: '-5.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-01-05', account: 'Expenses:Food', number: '20.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-01-05', account: 'Liabilities:CreditCard', number: '-20.00', currency: 'CNY' })
  return { db, handlers: register(db) }
}

describe('operatingCurrency 兜底（无 option → 按 postings 币种频次识别主币）', () => {
  it('无 operating_currency option：趋势按最高频币种聚合（2026-08-23 回归修复）', async () => {
    const db = createDrizzle(openDatabase(':memory:'))
    db.insert(ledgerMeta)
      .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '[]' })
      .run()
    insertPosting(db, { date: '2026-01-05', account: 'Expenses:Food', number: '20', currency: 'CNY' })
    insertPosting(db, { date: '2026-01-05', account: 'Liabilities:CreditCard', number: '-20', currency: 'CNY' })
    // 低频 USD 行不参与（主币 = CNY）
    insertPosting(db, { date: '2026-01-06', account: 'Expenses:Travel', number: '5', currency: 'USD' })
    const handlers = register(db)

    const r = (await handlers.get('report:net-worth')!({}, { granularity: 'month' })) as {
      series: Array<{ period: string; assets: string; liabilities: string; netWorth: string }>
      currency: string
    }
    expect(r.currency).toBe('CNY')
    expect(r.series).toEqual([
      { period: '2026-01', assets: '0', liabilities: '-20', netWorth: '-20' }
    ])
  })

  it('无 option 且无 postings：currency 为空，系列为空', async () => {
    const db = createDrizzle(openDatabase(':memory:'))
    db.insert(ledgerMeta)
      .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '[]' })
      .run()
    const handlers = register(db)

    const r = (await handlers.get('report:net-worth')!({}, { granularity: 'month' })) as {
      series: Array<{ period: string }>
      currency: string
    }
    expect(r.currency).toBe('')
    expect(r.series).toEqual([])
  })
})

describe('report:net-worth', () => {
  it('month：按期间累计，仅运营货币', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:net-worth')!({}, { granularity: 'month' })) as {
      series: Array<{ period: string; assets: string; liabilities: string; netWorth: string }>
      currency: string
    }
    expect(r.currency).toBe('CNY')
    expect(r.series).toEqual([
      { period: '2026-01', assets: '0', liabilities: '-20', netWorth: '-20' },
      { period: '2026-02', assets: '10000', liabilities: '-20', netWorth: '9980' },
      // 2026-03 只有 USD 行（非运营货币被过滤）→ 与 2 月持平
      { period: '2026-03', assets: '10000', liabilities: '-20', netWorth: '9980' }
    ])
  })

  it('起止年筛选：仅输出范围内期间，累计含范围前历史', async () => {
    const { handlers } = setupMultiYear()
    const r = (await handlers.get('report:net-worth')!({}, { granularity: 'month', startYear: 2026, endYear: 2026 })) as {
      series: Array<{ period: string; assets: string; liabilities: string; netWorth: string }>
    }
    expect(r.series).toEqual([
      // 2025 累计：assets = 10000 - 5 = 9995
      { period: '2026-01', assets: '9995', liabilities: '-20', netWorth: '9975' }
    ])
  })

  it('非法 granularity → throw', async () => {
    const { handlers } = setup()
    await expect(handlers.get('report:net-worth')!({}, { granularity: 'quarter' })).rejects.toThrow('granularity')
  })

  it('startYear > endYear → throw', async () => {
    const { handlers } = setup()
    await expect(
      handlers.get('report:net-worth')!({}, { granularity: 'month', startYear: 2026, endYear: 2025 })
    ).rejects.toThrow('startYear 不能大于 endYear')
  })
})

describe('report:balances', () => {
  it('账户树 + 子树 rollup + 多币种分行', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:balances')!()) as { accounts: Array<{ name: string; balances: Array<{ currency: string; number: string }> }> }
    const assets = r.accounts.find((a) => a.name === 'Assets')!
    expect(assets.balances).toEqual([
      { currency: 'CNY', number: '10000' },
      { currency: 'USD', number: '100' }
    ])
    const liabilities = r.accounts.find((a) => a.name === 'Liabilities')!
    expect(liabilities.balances).toEqual([{ currency: 'CNY', number: '-20' }])
    const income = r.accounts.find((a) => a.name === 'Income')!
    expect(income.balances).toEqual([{ currency: 'CNY', number: '10000' }])
  })

  it('endYear 筛选：余额为截至该年末的期末快照（startYear 不影响值）', async () => {
    const { handlers } = setupMultiYear()
    const r = (await handlers.get('report:balances')!({}, { startYear: 2025, endYear: 2025 })) as {
      accounts: Array<{ name: string; balances: Array<{ currency: string; number: string }> }>
    }
    const assets = r.accounts.find((a) => a.name === 'Assets')!
    expect(assets.balances).toEqual([{ currency: 'CNY', number: '9995' }])
    // 2026 的信用卡负债不参与
    expect(r.accounts.find((a) => a.name === 'Liabilities')).toBeUndefined()
    const income = r.accounts.find((a) => a.name === 'Income')!
    expect(income.balances).toEqual([{ currency: 'CNY', number: '10000' }])
  })
})

describe('report:income-expense', () => {
  it('month + 2026 单年：12 个月补满，income/expense 正显示', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:income-expense')!({}, { granularity: 'month', startYear: 2026, endYear: 2026 })) as {
      series: Array<{ period: string; income: string; expense: string }>
    }
    expect(r.series).toHaveLength(12)
    const jan = r.series.find((p) => p.period === '2026-01')!
    expect(jan).toEqual({ period: '2026-01', income: '0', expense: '20' })
    const feb = r.series.find((p) => p.period === '2026-02')!
    expect(feb).toEqual({ period: '2026-02', income: '10000', expense: '0' })
  })

  it('month 跨年范围：自 startYear-01 逐月补满至 endYear-12', async () => {
    const { handlers } = setupMultiYear()
    const r = (await handlers.get('report:income-expense')!({}, { granularity: 'month', startYear: 2025, endYear: 2026 })) as {
      series: Array<{ period: string; income: string; expense: string }>
    }
    expect(r.series).toHaveLength(24)
    expect(r.series[0].period).toBe('2025-01')
    expect(r.series.at(-1)?.period).toBe('2026-12')
    const mar = r.series.find((p) => p.period === '2025-03')!
    expect(mar).toEqual({ period: '2025-03', income: '10000', expense: '0' })
    const jun = r.series.find((p) => p.period === '2025-06')!
    expect(jun).toEqual({ period: '2025-06', income: '0', expense: '5' })
  })

  it('month 缺省范围 → 最近有数据的年份（兼容旧 year 行为）', async () => {
    const { handlers } = setupMultiYear()
    const r = (await handlers.get('report:income-expense')!({}, { granularity: 'month' })) as {
      series: Array<{ period: string }>
    }
    expect(r.series).toHaveLength(12)
    expect(r.series.every((p) => p.period.startsWith('2026-'))).toBe(true)
  })

  it('非法 startYear → throw', async () => {
    const { handlers } = setup()
    await expect(
      handlers.get('report:income-expense')!({}, { granularity: 'month', startYear: 'abc' })
    ).rejects.toThrow('startYear')
  })
})

describe('report:years', () => {
  it('返回账本全量年份范围（跨年账本）', async () => {
    const { handlers } = setupMultiYear()
    const r = (await handlers.get('report:years')!()) as { min: number; max: number }
    expect(r).toEqual({ min: 2025, max: 2026 })
  })

  it('无数据 → min/max 均为 0', async () => {
    const db = createDrizzle(openDatabase(':memory:'))
    db.insert(ledgerMeta)
      .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '["CNY"]' })
      .run()
    const handlers = register(db)
    const r = (await handlers.get('report:years')!()) as { min: number; max: number }
    expect(r).toEqual({ min: 0, max: 0 })
  })
})
