import { existsSync, readFileSync, appendFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzle, openDatabase } from './db'
import { registerLedgerHandlers, type IpcRegistrar } from './ipc-handlers'
import { PythonSvc } from './python-svc'

const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

describe('IPC handlers M5（read-file / save-file）', () => {
  let db: ReturnType<typeof createDrizzle>
  let engine: PythonSvc
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let workFile: string

  beforeAll(async () => {
    db = createDrizzle(openDatabase(':memory:'))
    engine = new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] })
    await engine.start()
    workFile = join(tmpdir(), `beanwise-m5-ipc-${process.pid}.beancount`)
    copyFileSync(FIXTURE, workFile)
    const ipc: IpcRegistrar = { handle: (channel, listener) => { handlers[channel] = listener as (...args: unknown[]) => unknown } }
    handlers = {}
    registerLedgerHandlers(ipc, { db, engine, ledgerPath: workFile })
  })
  afterAll(async () => {
    await engine.stop()
    db.$client.close()
  })

  it('ledger:read-file → ok + 全文 + sha256 指纹', async () => {
    const r = (await handlers['ledger:read-file']()) as {
      ok: boolean; content: string; fingerprint: string
    }
    expect(r.ok).toBe(true)
    expect(r.content).toContain('Breakfast')
    expect(r.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  }, 30_000)

  it('ledger:save-file 成功：tmp+rename 原子替换 + 索引重建 + 返回新指纹', async () => {
    const read = (await handlers['ledger:read-file']()) as { content: string; fingerprint: string }
    const content =
      read.content +
      '2026-08-09 * "M5 单测" "保存链路"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -10.00 CNY\n'
    const result = (await handlers['ledger:save-file']({}, {
      content, expectedFingerprint: read.fingerprint
    })) as { ok: boolean; status: string; entryCount: number; fingerprint: string }
    expect(result.ok).toBe(true)
    expect(result.status).toBe('ok')
    expect(result.entryCount).toBe(6)
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(workFile, 'utf8')).toBe(content) // 文件被替换为保存内容
    expect(existsSync(`${workFile}.m5tmp`)).toBe(false)  // 无残留 tmp
  }, 30_000)

  it('ledger:save-file 冲突：外部修改 → conflict + 快照，不落盘', async () => {
    const read = (await handlers['ledger:read-file']()) as { content: string; fingerprint: string }
    appendFileSync(workFile,
      '\n2026-08-09 * "外部" "修改"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
    const before = readFileSync(workFile, 'utf8')
    const result = (await handlers['ledger:save-file']({}, {
      content: 'totally different content', expectedFingerprint: read.fingerprint
    })) as { ok: boolean; conflict: boolean; diskContent: string; diskFingerprint: string }
    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.diskContent).toBe(before)
    expect(result.diskFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(workFile, 'utf8')).toBe(before) // 未落盘
  }, 30_000)

  it('ledger:save-file 校验失败：tmp 删除、原文件不动、不重建索引', async () => {
    const read = (await handlers['ledger:read-file']()) as { content: string; fingerprint: string }
    const before = readFileSync(workFile, 'utf8')
    const bad = '2026-08-09 * "坏" "内容"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -9.00 CNY\n'
    const result = (await handlers['ledger:save-file']({}, {
      content: bad, expectedFingerprint: read.fingerprint
    })) as { ok: boolean; conflict?: boolean; message?: string }
    expect(result.ok).toBe(false)
    expect(result.conflict).toBeUndefined()
    expect(result.message).toBeTruthy() // beancount 引擎错误文案（英文，勿断言具体词）
    expect(readFileSync(workFile, 'utf8')).toBe(before) // 原文件字节不变
    expect(existsSync(`${workFile}.m5tmp`)).toBe(false) // tmp 已清理
  }, 30_000)

  it('ledger:save-file 非法入参拒绝', async () => {
    await expect(handlers['ledger:save-file']({}, { content: 123, expectedFingerprint: 'x' })).rejects.toThrow()
    await expect(handlers['ledger:save-file']({}, { content: 'ok', expectedFingerprint: 'not-hex' })).rejects.toThrow()
    // 20MB 上限分支：校验是严格 >（恰好 20MB 允许），需超限 1 字节才触发拒绝
    await expect(handlers['ledger:save-file']({}, { content: 'x'.repeat(20 * 1024 * 1024 + 1), expectedFingerprint: 'a'.repeat(64) })).rejects.toThrow()
  })

  it('ledger:read-file ENOENT → ok:false', async () => {
    const missing: Record<string, (...args: unknown[]) => unknown> = {}
    const ipc: IpcRegistrar = { handle: (c, l) => { missing[c] = l as (...args: unknown[]) => unknown } }
    registerLedgerHandlers(ipc, {
      db, engine, ledgerPath: join(tmpdir(), 'beanwise-m5-no-such', 'ledger.beancount')
    })
    const r = (await missing['ledger:read-file']()) as { ok: boolean; message: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('账本文件不存在')
  }, 30_000)
})
