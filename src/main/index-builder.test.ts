import { copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzle, openDatabase } from './db'
import { getLedgerStatus, listEntries, refreshIndex } from './index-builder'
import { PythonSvc } from './python-svc'

const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const MAIN_FIXTURE = resolve('python/tests/fixtures/main.beancount')
const BAD_FIXTURE = resolve('python/tests/fixtures/bad.beancount')

describe('索引重建管线（M3）', () => {
  let db: ReturnType<typeof openDatabase>
  let drizzle: ReturnType<typeof createDrizzle>
  let engine: PythonSvc
  let workFile: string

  beforeAll(async () => {
    db = openDatabase(':memory:')
    drizzle = createDrizzle(db)
    engine = new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] })
    await engine.start()
    workFile = join(tmpdir(), `beanwise-m3-test-${process.pid}.beancount`)
    copyFileSync(MAIN_FIXTURE, workFile)
  })
  afterAll(async () => {
    await engine.stop()
    db.close()
  })

  it('首次刷新：合法账本 → ok + 5 entries + 2 条 Transaction 结构正确', async () => {
    const result = await refreshIndex(drizzle, engine, workFile)
    expect(result.status).toBe('ok')
    expect(result.entryCount).toBe(5)
    expect(result.errorCount).toBe(0)

    const status = getLedgerStatus(drizzle)
    expect(status?.title).toBe('BeanWise Test Ledger')
    expect(status?.operatingCurrency).toEqual(['CNY'])
    expect(status?.status).toBe('ok')

    const listed = listEntries(drizzle, 100, 0)
    expect(listed.total).toBe(5)
    const txs = listed.entries.filter((e) => e.type === 'Transaction')
    expect(txs).toHaveLength(2)
    // fixture 单字符串日期行（2026-01-02 * "Breakfast"）：beancount v3 解析为
    // narration 而非 payee（Task 1 实测确认，payee 为 null）
    expect(txs[0].narration).toBe('Breakfast')
    expect(txs[0].date).toBe('2026-01-02')
  }, 30_000)

  it('内容未变 → changed=false 跳过', async () => {
    const result = await refreshIndex(drizzle, engine, workFile)
    expect(result.changed).toBe(false)
  }, 30_000)

  it('文件追加一笔交易 → changed=true + entryCount=6，新条目可见', async () => {
    writeFileSync(
      workFile,
      '\n2026-01-04 * "Lunch"\n  Assets:Bank:CNB  -30.00 CNY\n  Expenses:Food\n',
      { flag: 'a' }
    )
    const result = await refreshIndex(drizzle, engine, workFile)
    expect(result.changed).toBe(true)
    expect(result.entryCount).toBe(6)
    const listed = listEntries(drizzle, 100, 0)
    expect(listed.entries.some((e) => e.narration === 'Lunch')).toBe(true)
  }, 30_000)

  it('坏账本 → status=error，旧索引保持（不重建）', async () => {
    copyFileSync(BAD_FIXTURE, workFile)
    const result = await refreshIndex(drizzle, engine, workFile)
    expect(result.status).toBe('error')
    expect(result.errorCount).toBe(1)
    expect(result.message).toContain('does not balance')
    // 旧索引仍为上一次 ok 的内容
    expect(getLedgerStatus(drizzle)?.entryCount).toBe(6)
    expect(listEntries(drizzle, 100, 0).total).toBe(6)
  }, 30_000)

  it('error 后文件回退到与上次 ok 完全一致的内容 → 重新解析，status 恢复 ok（防 stale error 残留）', async () => {
    // 坏内容解析失败时不更新 fileHash（有意保留上次 ok 的 hash）；若 skip guard 不要求
    // status==='ok'，回退到相同内容会误命中 skip → changed=false + 残留 error。
    copyFileSync(MAIN_FIXTURE, workFile)
    const first = await refreshIndex(drizzle, engine, workFile)
    expect(first.status).toBe('ok')
    copyFileSync(BAD_FIXTURE, workFile)
    const bad = await refreshIndex(drizzle, engine, workFile)
    expect(bad.status).toBe('error')
    expect(bad.changed).toBe(true)
    copyFileSync(MAIN_FIXTURE, workFile) // 内容与 first 完全一致（hash 相同）
    const again = await refreshIndex(drizzle, engine, workFile)
    expect(again.changed).toBe(true)
    expect(again.status).toBe('ok')
    expect(again.errorCount).toBe(0)
    expect(getLedgerStatus(drizzle)?.status).toBe('ok')
  }, 30_000)

  it('文件不存在 → status=missing', async () => {
    const result = await refreshIndex(drizzle, engine, join(tmpdir(), 'no-such-file.beancount'))
    expect(result.status).toBe('missing')
  }, 30_000)

  it('listEntries 分页 limit/offset 生效', async () => {
    copyFileSync(MAIN_FIXTURE, workFile)
    await refreshIndex(drizzle, engine, workFile)
    const page = listEntries(drizzle, 2, 1)
    expect(page.entries).toHaveLength(2)
    expect(page.total).toBe(5)
    expect(page.entries[0].date >= '2026-01-01').toBe(true) // 按 date, id 升序
  }, 30_000)

  it('listEntries order=desc → date,id 总体倒序（明细页默认，排序作用于全库）', async () => {
    copyFileSync(MAIN_FIXTURE, workFile)
    await refreshIndex(drizzle, engine, workFile)
    const page = listEntries(drizzle, 5, 0, 'desc')
    expect(page.entries).toHaveLength(5)
    expect(page.total).toBe(5)
    for (let i = 1; i < page.entries.length; i++) {
      const prev = page.entries[i - 1]!
      const cur = page.entries[i]!
      expect(prev.date > cur.date || (prev.date === cur.date && prev.id > cur.id)).toBe(true)
    }
  }, 30_000)

  it('listEntries 金额增强：Transaction 行带 amount/currency（PL 侧和取反 = 资产流），Open 行为 null', async () => {
    copyFileSync(MAIN_FIXTURE, workFile)
    await refreshIndex(drizzle, engine, workFile)
    const listed = listEntries(drizzle, 100, 0)
    const txs = listed.entries.filter((e) => e.type === 'Transaction')
    expect(txs).toHaveLength(2)
    const breakfast = txs.find((e) => e.narration === 'Breakfast')!
    // Expenses 15.00（隐式推平）→ PL 侧和取反 = -15（资产流出）
    expect(breakfast.amount).toBe('-15')
    expect(breakfast.currency).toBe('CNY')
    const opens = listed.entries.filter((e) => e.type === 'Open')
    expect(opens.every((e) => e.amount === null && e.currency === null)).toBe(true)
  }, 30_000)

  it('listEntries dateFrom/dateTo 过滤（含端点）且 total 同步', async () => {
    copyFileSync(MAIN_FIXTURE, workFile)
    await refreshIndex(drizzle, engine, workFile)
    const oneDay = listEntries(drizzle, 100, 0, 'asc', { dateFrom: '2026-01-02', dateTo: '2026-01-02' })
    expect(oneDay.total).toBe(1)
    expect(oneDay.entries.map((e) => e.narration)).toEqual(['Breakfast'])
    const from = listEntries(drizzle, 100, 0, 'asc', { dateFrom: '2026-01-02' })
    expect(from.total).toBe(2)
  }, 30_000)

  it('listEntries keyword 交易级命中（payee/narration/账户，LIKE 转义）', async () => {
    copyFileSync(MAIN_FIXTURE, workFile)
    await refreshIndex(drizzle, engine, workFile)
    const byNarration = listEntries(drizzle, 100, 0, 'asc', { keyword: 'Breakfast' })
    expect(byNarration.total).toBe(1)
    // posting 账户 Assets:Bank:CNB 命中 2 笔交易；Open 行 account 列同样命中 → 共 3
    const byAccount = listEntries(drizzle, 100, 0, 'asc', { keyword: 'Bank' })
    expect(byAccount.total).toBe(3)
    const none = listEntries(drizzle, 100, 0, 'asc', { keyword: '不存在XYZ' })
    expect(none.total).toBe(0)
    expect(none.entries).toHaveLength(0)
    // LIKE 通配符按字面匹配：'%' 不应放大命中
    const literal = listEntries(drizzle, 100, 0, 'asc', { keyword: '%' })
    expect(literal.total).toBe(0)
  }, 30_000)
})
