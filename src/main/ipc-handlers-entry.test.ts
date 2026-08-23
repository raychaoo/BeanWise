import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddEntryParams, AddEntryResult, ClearLedgerResult, ListAccountsResult } from '../shared/ipc'
import { createDrizzle, openDatabase } from './db'
import { entries, postings } from './db/schema'
import { registerLedgerHandlers, type IpcRegistrar } from './ipc-handlers'

// 录入口径测试用 mock refreshIndex（不 spawn 真实 Python 引擎）：
// 断言「写入后调用校验重建」与「error → truncate 回滚」的接线
const mocks = vi.hoisted(() => ({
  refreshIndex: vi.fn(),
  writeLedgerChecked: vi.fn()
}))

vi.mock('./index-builder', () => ({
  refreshIndex: mocks.refreshIndex,
  getLedgerStatus: vi.fn(),
  listEntries: vi.fn()
}))
vi.mock('./ledger-writer', () => ({ writeLedgerChecked: mocks.writeLedgerChecked }))

const validParams: AddEntryParams = {
  date: '2026-08-09',
  payee: '测试午饭',
  narration: 'M4 单测',
  postings: [
    { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
    { account: 'Assets:Cash', number: '-25.50', currency: 'CNY' }
  ]
}

const SERIALIZED =
  '2026-08-09 * "测试午饭" "M4 单测"\n  Expenses:Food  25.50 CNY\n  Assets:Cash  -25.50 CNY\n'

describe('IPC handlers ledger:add-entry / list-accounts（M4）', () => {
  let db: ReturnType<typeof createDrizzle>
  let dir: string

  function makeHandlers(ledgerPath: string): Record<string, (...args: unknown[]) => unknown> {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const ipc: IpcRegistrar = {
      handle: (channel, listener) => {
        handlers[channel] = listener as (...args: unknown[]) => unknown
      }
    }
    registerLedgerHandlers(ipc, { db, engine: {} as never, ledgerPath })
    return handlers
  }

  beforeEach(() => {
    db = createDrizzle(openDatabase(':memory:'))
    dir = mkdtempSync(join(tmpdir(), 'beanwise-m4-'))
    mocks.refreshIndex.mockReset()
    mocks.refreshIndex.mockResolvedValue({ changed: true, status: 'ok', entryCount: 6, errorCount: 0 })
    mocks.writeLedgerChecked.mockReset()
  })

  afterEach(() => {
    db.$client.close()
  })

  it('正常链路：追加写入序列化文本 → refreshIndex 被调用 → ok', async () => {
    const ledgerPath = join(dir, 'ledger.beancount')
    appendFileSync(ledgerPath, '2026-01-01 open Assets:Cash\n\n', 'utf8')
    const handlers = makeHandlers(ledgerPath)

    const result = (await handlers['ledger:add-entry']({}, validParams)) as AddEntryResult
    expect(result.ok).toBe(true)
    expect(result.status).toBe('ok')
    expect(result.entryCount).toBe(6)
    expect(mocks.refreshIndex).toHaveBeenCalledTimes(1)
    expect(readFileSync(ledgerPath, 'utf8')).toContain(SERIALIZED)
  })

  it('首文件：目录不存在自动创建，文件 = options 头 + 账户 open 行 + entry 块（beancount 未 open 账户报错）', async () => {
    const ledgerPath = join(dir, 'nested', 'deep', 'ledger.beancount')
    const handlers = makeHandlers(ledgerPath)

    const result = (await handlers['ledger:add-entry']({}, validParams)) as AddEntryResult
    expect(result.ok).toBe(true)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(
      'option "title" "BeanWise"\n' +
        'option "operating_currency" "CNY"\n' +
        '\n' +
        '2026-08-09 open Expenses:Food\n' +
        '2026-08-09 open Assets:Cash\n' +
        '2026-08-09 * "测试午饭" "M4 单测"\n' +
        '  Expenses:Food  25.50 CNY\n' +
        '  Assets:Cash  -25.50 CNY\n'
    )
  })

  it('余额不平 → throw「借贷不平衡」，文件未创建/未改动', async () => {
    const ledgerPath = join(dir, 'ledger.beancount')
    appendFileSync(ledgerPath, '2026-01-01 open Assets:Cash\n', 'utf8')
    const before = readFileSync(ledgerPath, 'utf8')
    const handlers = makeHandlers(ledgerPath)

    await expect(
      handlers['ledger:add-entry']({}, {
        ...validParams,
        postings: [
          { account: 'Expenses:Food', number: '100.00', currency: 'CNY' },
          { account: 'Assets:Cash', number: '-99.00', currency: 'CNY' }
        ]
      })
    ).rejects.toThrow('借贷不平衡：差额 -1')

    expect(mocks.refreshIndex).not.toHaveBeenCalled()
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)

    // 首文件场景：余额不平 → 文件不被创建
    const freshPath = join(dir, 'fresh.beancount')
    const fresh = makeHandlers(freshPath)
    await expect(fresh['ledger:add-entry']({}, {
      ...validParams,
      postings: [
        { account: 'Expenses:Food', number: '1.00', currency: 'CNY' },
        { account: 'Assets:Cash', number: '2.00', currency: 'CNY' }
      ]
    })).rejects.toThrow(/借贷不平衡/)
    expect(existsSync(freshPath)).toBe(false)
  })

  it('两行都是收支账户 → 前置语义校验拒绝，文件不变', async () => {
    const ledgerPath = join(dir, 'ledger.beancount')
    appendFileSync(ledgerPath, '2026-01-01 open Assets:Cash\n', 'utf8')
    const before = readFileSync(ledgerPath, 'utf8')
    const handlers = makeHandlers(ledgerPath)

    await expect(
      handlers['ledger:add-entry']({}, {
        ...validParams,
        postings: [
          { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
          { account: 'Expenses:Shopping', number: '-25.50', currency: 'CNY' }
        ]
      })
    ).rejects.toThrow('交易不能全部为收支账户')

    expect(mocks.refreshIndex).not.toHaveBeenCalled()
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)
  })

  it('索引 error → truncate 回滚到原长度 + ok:false', async () => {
    const ledgerPath = join(dir, 'ledger.beancount')
    const original = '2026-01-01 open Assets:Cash\n'
    appendFileSync(ledgerPath, original, 'utf8')
    const preSize = statSync(ledgerPath).size
    mocks.refreshIndex.mockResolvedValue({
      changed: true,
      status: 'error',
      entryCount: 3,
      errorCount: 1,
      message: '解析失败'
    })
    const handlers = makeHandlers(ledgerPath)

    const result = (await handlers['ledger:add-entry']({}, validParams)) as AddEntryResult
    expect(result.ok).toBe(false)
    expect(result.status).toBe('error')
    expect(result.message).toBe('解析失败')
    expect(result.entryCount).toBe(3)
    // 文件被回滚：长度与内容均与追加前一致
    expect(statSync(ledgerPath).size).toBe(preSize)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(original)
  })

  it('文件尾无换行 → 先补 \n 再追加', async () => {
    const ledgerPath = join(dir, 'ledger.beancount')
    appendFileSync(ledgerPath, '2026-01-01 open Assets:Cash', 'utf8') // 无尾换行
    const handlers = makeHandlers(ledgerPath)

    await handlers['ledger:add-entry']({}, validParams)
    // Expenses:Food 未 open → 追加前自动补 open 行（修复 Equity:AutoBalance unknown account 同类问题）
    expect(readFileSync(ledgerPath, 'utf8')).toBe(
      '2026-01-01 open Assets:Cash\n' +
      '2026-08-09 open Expenses:Food\n' +
      SERIALIZED
    )
  })

  it('ledger:list-accounts：postings 表 DISTINCT + 排序', async () => {
    const entry = db.insert(entries).values({ type: 'Transaction', date: '2026-08-09' }).returning().get()
    db.insert(postings)
      .values([
        { entryId: entry.id, account: 'Expenses:Food', unitsNumber: '25.50', unitsCurrency: 'CNY' },
        { entryId: entry.id, account: 'Assets:Cash', unitsNumber: '-25.50', unitsCurrency: 'CNY' },
        { entryId: entry.id, account: 'Expenses:Food', unitsNumber: '5', unitsCurrency: 'CNY' }
      ])
      .run()
    const handlers = makeHandlers(join(dir, 'ledger.beancount'))

    const result = (await handlers['ledger:list-accounts']()) as ListAccountsResult
    expect(result.accounts).toEqual(['Assets:Cash', 'Expenses:Food'])
  })

  it('ledger:clear：只清交易/open，保留 option 行（title/operating_currency）并重建索引', async () => {
    const ledgerPath = join(dir, 'ledger.beancount')
    appendFileSync(
      ledgerPath,
      'option "title" "我的账本"\noption "operating_currency" "CNY"\n\n2026-01-01 open Assets:Cash\n2026-01-01 * "x"\n  Assets:Cash  1 CNY\n  Income:Salary  -1 CNY\n',
      'utf8'
    )
    mocks.writeLedgerChecked.mockImplementation(async (_deps: unknown, content: string) => {
      writeFileSync(ledgerPath, content, 'utf8')
      return { ok: true }
    })
    mocks.refreshIndex.mockResolvedValue({ changed: true, status: 'ok', entryCount: 0, errorCount: 0 })
    const handlers = makeHandlers(ledgerPath)

    const result = (await handlers['ledger:clear']()) as ClearLedgerResult
    expect(result.ok).toBe(true)
    expect(result.entryCount).toBe(0)
    expect(readFileSync(ledgerPath, 'utf8')).toBe('option "title" "我的账本"\noption "operating_currency" "CNY"\n')
    expect(mocks.refreshIndex).toHaveBeenCalledTimes(1)
  })
})
