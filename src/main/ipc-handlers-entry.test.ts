import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddEntryParams, AddEntryResult, ListAccountsResult } from '../shared/ipc'
import { createDrizzle, openDatabase } from './db'
import { entries, postings } from './db/schema'
import { registerLedgerHandlers, type IpcRegistrar } from './ipc-handlers'

// 录入口径测试用 mock refreshIndex（不 spawn 真实 Python 引擎）：
// 断言「写入后调用校验重建」与「error → truncate 回滚」的接线
const mocks = vi.hoisted(() => ({
  refreshIndex: vi.fn()
}))

vi.mock('./index-builder', () => ({
  refreshIndex: mocks.refreshIndex,
  getLedgerStatus: vi.fn(),
  listEntries: vi.fn()
}))

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

  it('首文件：目录不存在自动创建，文件内容恰为 entry 块（无前导空行）', async () => {
    const ledgerPath = join(dir, 'nested', 'deep', 'ledger.beancount')
    const handlers = makeHandlers(ledgerPath)

    const result = (await handlers['ledger:add-entry']({}, validParams)) as AddEntryResult
    expect(result.ok).toBe(true)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(SERIALIZED)
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
    expect(readFileSync(ledgerPath, 'utf8')).toBe('2026-01-01 open Assets:Cash\n' + SERIALIZED)
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
})
