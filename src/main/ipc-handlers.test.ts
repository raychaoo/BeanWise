import { copyFileSync } from 'node:fs'
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
})
