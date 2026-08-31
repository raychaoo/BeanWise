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
  return registerWithDeps({ db })
}

/** 带完整依赖注册（PDF 导出测试注入 printToPDF/dialog/writeFile mock） */
function registerWithDeps(deps: ReportDeps): Map<string, (...args: unknown[]) => Promise<unknown>> {
  const registrar = makeRegistrar()
  registerReportHandlers(registrar, deps)
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

/** 插入同一分录的多条 posting（共享一个 entry——现金流量表按分录配对判定流入/流出） */
function insertEntryPostings(
  db: ReportDeps['db'],
  date: string,
  legs: Array<{ account: string; number: string; currency: string }>
): void {
  const entry = db
    .insert(entries)
    .values({ type: 'Transaction', date, narration: 't' })
    .returning()
    .get()
  for (const leg of legs) {
    db.insert(postings)
      .values({ entryId: entry.id, account: leg.account, unitsNumber: leg.number, unitsCurrency: leg.currency })
      .run()
  }
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

describe('report:trial-balance', () => {
  it('三栏：opening = dateFrom 前累计，period = 区间净额，closing = opening + period', async () => {
    const { handlers } = setupMultiYear()
    const r = (await handlers.get('report:trial-balance')!({}, { dateFrom: '2026-01-01', dateTo: '2026-12-31' })) as {
      rows: Array<{ name: string; opening: { number: string; currency: string }; period: { number: string; currency: string }; closing: { number: string; currency: string } }>
    }
    const cnb = r.rows.find((x) => x.name === 'Assets:Bank:CNB' && x.opening.currency === 'CNY')!
    // 2025 全量：+10000 -5 = 9995 → opening；2026 区间无发生 → period 0
    expect(cnb.opening).toEqual({ number: '9995', currency: 'CNY' })
    expect(cnb.period).toEqual({ number: '0', currency: 'CNY' })
    expect(cnb.closing).toEqual({ number: '9995', currency: 'CNY' })
    const food = r.rows.find((x) => x.name === 'Expenses:Food' && x.opening.currency === 'CNY')!
    expect(food.opening).toEqual({ number: '0', currency: 'CNY' })
    expect(food.period).toEqual({ number: '20', currency: 'CNY' })
    expect(food.closing).toEqual({ number: '20', currency: 'CNY' })
    const cc = r.rows.find((x) => x.name === 'Liabilities:CreditCard')!
    expect(cc.period).toEqual({ number: '-20', currency: 'CNY' })
    expect(cc.closing).toEqual({ number: '-20', currency: 'CNY' })
    // Income 正显示（与余额树同口径）
    const salary = r.rows.find((x) => x.name === 'Income:Salary')!
    expect(salary.closing).toEqual({ number: '10000', currency: 'CNY' })
  })

  it('缺省参数：全量，opening = 0、period = 全部净额', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:trial-balance')!({})) as {
      rows: Array<{ name: string; opening: { number: string; currency: string }; period: { number: string; currency: string }; closing: { number: string; currency: string } }>
    }
    const cnb = r.rows.find((x) => x.name === 'Assets:Bank:CNB' && x.opening.currency === 'CNY')!
    expect(cnb.opening).toEqual({ number: '0', currency: 'CNY' })
    expect(cnb.period).toEqual({ number: '10000', currency: 'CNY' })
    expect(cnb.closing).toEqual({ number: '10000', currency: 'CNY' })
    // 多币种分行（USD 单独一行）
    const usd = r.rows.find((x) => x.name === 'Assets:Bank:USD')!
    expect(usd.closing).toEqual({ number: '100', currency: 'USD' })
  })

  it('非法日期 / dateFrom > dateTo → throw', async () => {
    const { handlers } = setup()
    await expect(handlers.get('report:trial-balance')!({}, { dateFrom: '2026/01/01' })).rejects.toThrow('dateFrom')
    await expect(
      handlers.get('report:trial-balance')!({}, { dateFrom: '2026-02-01', dateTo: '2026-01-01' })
    ).rejects.toThrow('dateFrom 不能大于 dateTo')
  })
})

describe('report:cash-flow', () => {
  it('Assets 资金池口径：收入流入 / 支出流出 / 池内互转不计 / 净额正确（month 分组）', async () => {
    const db = createDrizzle(openDatabase(':memory:'))
    db.insert(ledgerMeta)
      .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '["CNY"]' })
      .run()
    // 收入（流入 10000）
    insertEntryPostings(db, '2026-01-05', [
      { account: 'Assets:Bank:CNB', number: '10000', currency: 'CNY' },
      { account: 'Income:Salary', number: '-10000', currency: 'CNY' }
    ])
    // 支出（流出 35）
    insertEntryPostings(db, '2026-01-10', [
      { account: 'Expenses:Food', number: '35', currency: 'CNY' },
      { account: 'Assets:Bank:CNB', number: '-35', currency: 'CNY' }
    ])
    // 池内互转（不计）
    insertEntryPostings(db, '2026-01-15', [
      { account: 'Assets:Bank:CNB', number: '-500', currency: 'CNY' },
      { account: 'Assets:Cash', number: '500', currency: 'CNY' }
    ])
    // 负债还款（流出 20，次月）
    insertEntryPostings(db, '2026-02-01', [
      { account: 'Liabilities:CreditCard', number: '20', currency: 'CNY' },
      { account: 'Assets:Bank:CNB', number: '-20', currency: 'CNY' }
    ])
    const handlers = register(db)
    const r = (await handlers.get('report:cash-flow')!({}, { granularity: 'month' })) as {
      series: Array<{ period: string; inflow: string; outflow: string; net: string }>
      currency: string
    }
    expect(r.currency).toBe('CNY')
    expect(r.series).toEqual([
      { period: '2026-01', inflow: '10000', outflow: '35', net: '9965' },
      { period: '2026-02', inflow: '0', outflow: '20', net: '-20' }
    ])
  })

  it('dateFrom/dateTo 区间筛选 + 非法日期/区间 throw', async () => {
    const db = createDrizzle(openDatabase(':memory:'))
    db.insert(ledgerMeta)
      .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '["CNY"]' })
      .run()
    insertEntryPostings(db, '2026-01-05', [
      { account: 'Assets:Bank:CNB', number: '10000', currency: 'CNY' },
      { account: 'Income:Salary', number: '-10000', currency: 'CNY' }
    ])
    insertEntryPostings(db, '2026-02-01', [
      { account: 'Assets:Bank:CNB', number: '5000', currency: 'CNY' },
      { account: 'Income:Bonus', number: '-5000', currency: 'CNY' }
    ])
    const handlers = register(db)
    const r = (await handlers.get('report:cash-flow')!(
      {},
      { granularity: 'month', dateFrom: '2026-02-01', dateTo: '2026-02-28' }
    )) as { series: Array<{ period: string; inflow: string; outflow: string; net: string }> }
    expect(r.series).toEqual([{ period: '2026-02', inflow: '5000', outflow: '0', net: '5000' }])
    // 无区间 → 两月都在
    const all = (await handlers.get('report:cash-flow')!({}, { granularity: 'month' })) as {
      series: Array<{ period: string }>
    }
    expect(all.series.map((p) => p.period)).toEqual(['2026-01', '2026-02'])
    await expect(handlers.get('report:cash-flow')!({}, { granularity: 'quarter' })).rejects.toThrow('granularity')
    await expect(
      handlers.get('report:cash-flow')!({}, { granularity: 'month', dateFrom: '2026-02-01', dateTo: '2026-01-01' })
    ).rejects.toThrow('dateFrom 不能大于 dateTo')
  })
})

describe('report:export-pdf', () => {
  type PrintToPdfMock = (options?: object) => Promise<Buffer>
  type SaveDialogMock = (options?: object) => Promise<{ canceled: boolean; filePath?: string }>
  type WriteFileMock = (filePath: string, data: Uint8Array) => Promise<void>

  function pdfDeps(overrides: {
    printToPDF?: PrintToPdfMock
    showSaveDialog?: SaveDialogMock
    writeFile?: WriteFileMock
  } = {}) {
    return {
      db: setup().db,
      getWindow: () => ({
        webContents: { printToPDF: overrides.printToPDF ?? (async () => Buffer.from('%PDF-1.4 test')) }
      }),
      showSaveDialog: overrides.showSaveDialog ?? (async () => ({ canceled: false, filePath: 'C:\\out\\report.pdf' })),
      writeFile: overrides.writeFile ?? (async () => undefined)
    }
  }

  it('成功路径：printToPDF → showSaveDialog → writeFile → { ok:true, path }', async () => {
    const printToPDF = vi.fn<PrintToPdfMock>().mockResolvedValue(Buffer.from('%PDF-1.4 test'))
    const showSaveDialog = vi.fn<SaveDialogMock>().mockResolvedValue({ canceled: false, filePath: 'C:\\out\\report.pdf' })
    const writeFile = vi.fn<WriteFileMock>().mockResolvedValue(undefined)
    const handlers = registerWithDeps(pdfDeps({ printToPDF, showSaveDialog, writeFile }))

    const r = (await handlers.get('report:export-pdf')!({})) as { ok: boolean; path?: string; message?: string }
    expect(r).toEqual({ ok: true, path: 'C:\\out\\report.pdf' })
    expect(printToPDF).toHaveBeenCalledWith({ printBackground: true, pageSize: 'A4' })
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: expect.stringMatching(/^BeanWise-报表-\d{4}-\d{2}-\d{2}\.pdf$/) })
    )
    expect(writeFile).toHaveBeenCalledWith('C:\\out\\report.pdf', Buffer.from('%PDF-1.4 test'))
  })

  it('取消保存：不写文件，返回 { ok:true }（无 path）', async () => {
    const showSaveDialog = vi.fn<SaveDialogMock>().mockResolvedValue({ canceled: true })
    const writeFile = vi.fn<WriteFileMock>().mockResolvedValue(undefined)
    const handlers = registerWithDeps(pdfDeps({ showSaveDialog, writeFile }))

    const r = (await handlers.get('report:export-pdf')!({})) as { ok: boolean; path?: string; message?: string }
    expect(r).toEqual({ ok: true })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('打印异常：返回 { ok:false, message }', async () => {
    const printToPDF = vi.fn<PrintToPdfMock>().mockRejectedValue(new Error('print failed'))
    const handlers = registerWithDeps(pdfDeps({ printToPDF }))

    const r = (await handlers.get('report:export-pdf')!({})) as { ok: boolean; path?: string; message?: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('print failed')
    expect(r.path).toBeUndefined()
  })

  it('无窗口：返回 { ok:false }', async () => {
    const handlers = registerWithDeps({ db: setup().db, getWindow: () => null, showSaveDialog: vi.fn(), writeFile: vi.fn() })
    const r = (await handlers.get('report:export-pdf')!({})) as { ok: boolean; message?: string }
    expect(r).toEqual({ ok: false, message: expect.stringContaining('未找到应用窗口') })
  })
})
