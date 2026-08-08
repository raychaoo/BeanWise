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
})
