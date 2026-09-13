import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddEntryParams, AddEntryResult, ClearLedgerResult, GetEntryResult, ListAccountsResult, UpdateEntryParams } from '../../../shared/ipc'
import { createDrizzle, openDatabase } from '../../db/index'
import { entries, postings } from '../../db/schema'
import { registerLedgerHandlers, type IpcRegistrar } from '../ledger/ipc-handlers'

// 录入口径测试用 mock refreshIndex（不 spawn 真实 Python 引擎）：
// 断言「写入后调用校验重建」与「error → truncate 回滚」的接线
const mocks = vi.hoisted(() => ({
  getEntryById: vi.fn(),
  refreshIndex: vi.fn(),
  writeLedgerChecked: vi.fn()
}))

vi.mock('../../core/index-builder', () => ({
  getEntryById: mocks.getEntryById,
  refreshIndex: mocks.refreshIndex,
  getLedgerStatus: vi.fn(),
  listEntries: vi.fn()
}))
vi.mock('../../utils/ledger-writer', () => ({ writeLedgerChecked: mocks.writeLedgerChecked }))

const validParams: AddEntryParams = {
  date: '2026-08-09',
  id: 'bw-m4-test',
  time: '2026-08-09 12:34:56',
  payee: '测试午饭',
  narration: 'M4 单测',
  postings: [
    { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
    { account: 'Assets:Cash', number: '-25.50', currency: 'CNY' }
  ]
}

const SERIALIZED =
  '2026-08-09 * "测试午饭" "M4 单测"\n' +
  '  id: "bw-m4-test"\n' +
  '  time: "2026-08-09 12:34:56"\n' +
  '  Expenses:Food  25.50 CNY\n' +
  '  Assets:Cash  -25.50 CNY\n'

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
    mocks.getEntryById.mockReset()
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
        '  id: "bw-m4-test"\n' +
        '  time: "2026-08-09 12:34:56"\n' +
        '  Expenses:Food  25.50 CNY\n' +
        '  Assets:Cash  -25.50 CNY\n'
    )
  })

  it('缺省 id/time → 自动补齐稳定格式后落盘', async () => {
    const ledgerPath = join(dir, 'auto-meta.beancount')
    appendFileSync(ledgerPath, '2026-01-01 open Assets:Cash\n2026-01-01 open Expenses:Food\n\n', 'utf8')
    const handlers = makeHandlers(ledgerPath)
    const { id: _id, time: _time, ...withoutMeta } = validParams

    await handlers['ledger:add-entry']({}, withoutMeta)

    const content = readFileSync(ledgerPath, 'utf8')
    expect(content).toMatch(/^  id: "bw-[0-9a-f-]{36}"$/m)
    expect(content).toMatch(/^  time: "2026-08-09 00:00:00"$/m)
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

  it('ledger:update-entry：按稳定 id 替换单笔交易并重建索引', async () => {
    const ledgerPath = join(dir, 'update.beancount')
    appendFileSync(
      ledgerPath,
      '2026-01-01 open Assets:Cash\n' +
        '2026-01-01 open Expenses:Food\n\n' +
        '2026-08-09 * "旧交易" "旧说明"\n' +
        '  id: "bw-old"\n' +
        '  time: "2026-08-09 08:00:00"\n' +
        '  Expenses:Food  25.50 CNY\n' +
        '  Assets:Cash  -25.50 CNY\n\n' +
        '2026-08-10 * "别动" "保留"\n' +
        '  id: "bw-keep"\n' +
        '  time: "2026-08-10 09:00:00"\n' +
        '  Expenses:Food  10.00 CNY\n' +
        '  Assets:Cash  -10.00 CNY\n',
      'utf8'
    )
    mocks.writeLedgerChecked.mockImplementation(async (_deps: unknown, content: string) => {
      writeFileSync(ledgerPath, content, 'utf8')
      return { ok: true }
    })
    const handlers = makeHandlers(ledgerPath)

    const result = (await handlers['ledger:update-entry']({}, {
      id: 'bw-old',
      date: '2026-08-09',
      time: '2026-08-09 12:34:56',
      payee: '新交易',
      narration: '新说明',
      postings: [
        { account: 'Expenses:Food', number: '30.00', currency: 'CNY' },
        { account: 'Assets:Cash', number: '-30.00', currency: 'CNY' }
      ]
    })) as AddEntryResult

    expect(result.ok).toBe(true)
    expect(mocks.writeLedgerChecked).toHaveBeenCalledTimes(1)
    expect(mocks.refreshIndex).toHaveBeenCalledTimes(1)
    const content = readFileSync(ledgerPath, 'utf8')
    expect(content).toContain('2026-08-09 * "新交易" "新说明"')
    expect(content).toContain('  time: "2026-08-09 12:34:56"')
    expect(content).toContain('  Expenses:Food  30.00 CNY')
    expect(content).toContain('2026-08-10 * "别动" "保留"')
    expect(content.match(/id: "bw-old"/g)).toHaveLength(1)
  })

  it('ledger:update-entry：ID 不存在 → 拒绝且不写盘', async () => {
    const ledgerPath = join(dir, 'update-missing.beancount')
    appendFileSync(ledgerPath, '2026-01-01 open Assets:Cash\n', 'utf8')
    const before = readFileSync(ledgerPath, 'utf8')
    const handlers = makeHandlers(ledgerPath)

    await expect(handlers['ledger:update-entry']({}, {
      id: 'bw-missing',
      date: '2026-08-09',
      payee: 'x',
      postings: [
        { account: 'Expenses:Food', number: '1.00', currency: 'CNY' },
        { account: 'Assets:Cash', number: '-1.00', currency: 'CNY' }
      ]
    })).rejects.toThrow(/未找到/)
    expect(mocks.writeLedgerChecked).not.toHaveBeenCalled()
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)
  })

  it('ledger:get-entry：按 ID 返回完整交易；不存在返回 ok:false', async () => {
    const detail: UpdateEntryParams = {
      id: 'bw-detail-001',
      date: '2026-09-12',
      time: '2026-09-12 18:20:30',
      flag: '*',
      payee: '商户',
      narration: '二次编辑',
      links: ['lend-001'],
      postings: [
        { account: 'Assets:Receivables:Lend', number: '30.00', currency: 'CNY', counterparty: '李志全' },
        { account: 'Assets:Cash', number: '-30.00', currency: 'CNY' }
      ]
    }
    mocks.getEntryById.mockReturnValueOnce(detail).mockReturnValueOnce(null)
    const handlers = makeHandlers(join(dir, 'ledger.beancount'))

    expect(await handlers['ledger:get-entry']({}, { id: 'bw-detail-001' })).toEqual({
      ok: true,
      entry: detail
    })
    expect(await handlers['ledger:get-entry']({}, { id: 'bw-missing' })).toEqual({
      ok: false,
      message: '未找到交易 ID: bw-missing'
    })
    expect(() => handlers['ledger:get-entry']({}, { id: '' })).toThrow(/id/)
  })
})
