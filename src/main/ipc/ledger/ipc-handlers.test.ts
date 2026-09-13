import { copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzle, openDatabase, type DrizzleDb } from '../../db/index'
import { entries, entryLinks, postings } from '../../db/schema'
import { listCounterparties, registerLedgerHandlers, withAutoLinks, type IpcRegistrar } from './ipc-handlers'
import type { AddEntryParams } from '../../../shared/ipc'
import { PythonSvc } from '../../core/python-svc'

const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

describe('IPC handlers（M3）', () => {
  let db: ReturnType<typeof createDrizzle>
  let engine: PythonSvc
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let workFile: string

  beforeAll(async () => {
    // 注意：handlers 消费 DrizzleDb（Task 4 实测：raw Database 无 .select()，必须 createDrizzle 包装）
    db = createDrizzle(openDatabase(':memory:'))

    engine = new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] })
    await engine.start()
    workFile = join(tmpdir(), `beanwise-m3-ipc-${process.pid}.beancount`)
    copyFileSync(FIXTURE, workFile)

    const ipc: IpcRegistrar = {
      handle: (channel, listener) => {
        handlers[channel] = listener as (...args: unknown[]) => unknown
      }
    }
    handlers = {}
    registerLedgerHandlers(ipc, { db, engine, ledgerPath: workFile })
  })
  afterAll(async () => {
    await engine.stop()
    db.$client.close()
  })

  it('ledger:refresh-index → ok + 5 entries；ledger:status 一致', async () => {
    const result = (await handlers['ledger:refresh-index']()) as { status: string; entryCount: number }
    expect(result.status).toBe('ok')
    expect(result.entryCount).toBe(5)

    const status = (await handlers['ledger:status']()) as { path: string; status: string }
    expect(status.path).toBe(workFile)
    expect(status.status).toBe('ok')
  }, 30_000)

  it('ledger:list-entries 默认分页与非法入参拒绝', async () => {
    const listed = (await handlers['ledger:list-entries'](undefined)) as {
      entries: Array<{ type: string; narration: string | null }>
      total: number
    }
    expect(listed.total).toBe(5)
    // 同 Task 4：fixture 单字符串日期行解析为 narration（Task 1 实测）。
    // 注意排序：3 条 open（2026-01-01）在 Transaction 之前，断言须按 type 过滤取首条 Transaction。
    const txs = listed.entries.filter((e) => e.type === 'Transaction')
    expect(txs[0].narration).toBe('Breakfast')

    // Electron 监听器签名 (event, ...args)：mock 直呼时先传 event 占位，再传 params
    await expect(handlers['ledger:list-entries']({}, { limit: -1 })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({}, { offset: -5 })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({}, { limit: 5000 })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({}, { limit: '100' })).rejects.toThrow()
  }, 30_000)

  it('ledger:list-entries account 参数透传与非法值拒绝', async () => {
    const listed = (await handlers['ledger:list-entries']({}, { account: 'Expenses:Food' })) as {
      entries: Array<{ narration: string | null }>
      total: number
    }
    expect(listed.total).toBe(2)
    expect(listed.entries.map((e) => e.narration)).toEqual(['Breakfast', 'Coffee'])

    await expect(handlers['ledger:list-entries']({}, { account: '' })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({}, { account: 123 })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({}, { account: 'x'.repeat(201) })).rejects.toThrow()
  }, 30_000)
})

describe('listCounterparties（ADR 23 往来对象候选）', () => {
  it('去重、剔除 null（未标注的历史行不是候选）', () => {
    const db = createDrizzle(openDatabase(':memory:'))
    const entry = db
      .insert(entries)
      .values({ type: 'Transaction', date: '2026-01-01', narration: 't' })
      .returning()
      .get()
    for (const counterparty of ['王五', '李志全', null, '李志全']) {
      db.insert(postings)
        .values({ entryId: entry.id, account: 'Assets:Receivables:Lend', unitsNumber: '1', unitsCurrency: 'CNY', counterparty })
        .run()
    }
    const result = listCounterparties(db)
    expect(result).toHaveLength(2)
    expect(new Set(result)).toEqual(new Set(['李志全', '王五']))
  })
})

/** 造一笔已挂链的往来交易（借出为正、还款为负） */
function seedLoan(
  db: DrizzleDb,
  opts: { date: string; amount: string; link: string; counterparty: string }
): void {
  const entry = db
    .insert(entries)
    .values({ type: 'Transaction', date: opts.date, narration: 't' })
    .returning()
    .get()
  db.insert(postings)
    .values({
      entryId: entry.id,
      account: 'Assets:Receivables:Lend',
      unitsNumber: opts.amount,
      unitsCurrency: 'CNY',
      counterparty: opts.counterparty
    })
    .run()
  db.insert(entryLinks).values({ entryId: entry.id, link: opts.link }).run()
}

describe('withAutoLinks（ADR 23 P2 自动盖/挂贷款 link）', () => {
  const CP = ['Assets:Receivables:Lend']
  const lend: AddEntryParams = {
    date: '2026-09-01',
    payee: '测试',
    postings: [
      { account: 'Assets:Receivables:Lend', number: '500', currency: 'CNY', counterparty: '李志全' },
      { account: 'Assets:Bank:CNY', number: '-500', currency: 'CNY' }
    ]
  }
  const repay = (counterparty: string): AddEntryParams => ({
    date: '2026-09-02',
    payee: '测试',
    postings: [
      { account: 'Assets:Receivables:Lend', number: '-100', currency: 'CNY', counterparty },
      { account: 'Assets:Bank:CNY', number: '100', currency: 'CNY' }
    ]
  })

  it('新借出 → 盖一个新贷款 ID（lend- 前缀、纯 ASCII）', () => {
    const db = createDrizzle(openDatabase(':memory:'))
    const r = withAutoLinks(lend, { db, counterpartyAccounts: () => CP })
    expect(r.links).toHaveLength(1)
    expect(r.links![0]).toMatch(/^lend-[A-Za-z0-9]{12,40}$/)
  })

  it('还款 → FIFO 挂最早的未结贷款；该对象无未结则不挂', () => {
    const db = createDrizzle(openDatabase(':memory:'))
    seedLoan(db, { date: '2026-08-01', amount: '300', link: 'lend-old', counterparty: '李志全' })
    seedLoan(db, { date: '2026-08-15', amount: '200', link: 'lend-new', counterparty: '李志全' })

    expect(withAutoLinks(repay('李志全'), { db, counterpartyAccounts: () => CP }).links).toEqual(['lend-old'])
    // 陌生人无未结借出 → 不加 link（beancount 只记不存在的 link 也不报错）
    expect(withAutoLinks(repay('张三'), { db, counterpartyAccounts: () => CP }).links).toBeUndefined()
  })

  it('已结清的贷款不再被挂；调用方显式 links 优先于自动判定', () => {
    const db = createDrizzle(openDatabase(':memory:'))
    seedLoan(db, { date: '2026-08-01', amount: '300', link: 'lend-old', counterparty: '李志全' })
    seedLoan(db, { date: '2026-08-02', amount: '-300', link: 'lend-old', counterparty: '李志全' }) // 已还清
    seedLoan(db, { date: '2026-08-15', amount: '200', link: 'lend-new', counterparty: '李志全' })

    expect(withAutoLinks(repay('李志全'), { db, counterpartyAccounts: () => CP }).links).toEqual(['lend-new'])
    expect(
      withAutoLinks({ ...lend, links: ['lend-explicit'] }, { db, counterpartyAccounts: () => CP }).links
    ).toEqual(['lend-explicit'])
  })

  it('非往来类账户 / 未注入账户列表 → 一律不加', () => {
    const db = createDrizzle(openDatabase(':memory:'))
    const plain: AddEntryParams = {
      date: '2026-09-01',
      postings: [
        { account: 'Expenses:Food', number: '50', currency: 'CNY' },
        { account: 'Assets:Bank:CNY', number: '-50', currency: 'CNY' }
      ]
    }
    expect(withAutoLinks(plain, { db, counterpartyAccounts: () => CP }).links).toBeUndefined()
    expect(withAutoLinks(lend, { db }).links).toBeUndefined()
    expect(withAutoLinks(lend, { db, counterpartyAccounts: () => [] }).links).toBeUndefined()
  })
})
