import type { ListEntriesParams, RefreshResult } from '../shared/ipc'
import type { DrizzleDb } from './db'
import { getLedgerStatus, listEntries, refreshIndex } from './index-builder'
import type { PythonSvc } from './python-svc'

/** 可注入的 IPC 注册器（测试传 mock，主进程传 electron.ipcMain） */
export interface IpcRegistrar {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
}

export interface LedgerDeps {
  db: DrizzleDb
  engine: PythonSvc
  /** 账本文件路径（主进程持有，渲染进程不传路径——防目录穿越） */
  ledgerPath: string
}

const MAX_LIMIT = 1_000
const DEFAULT_LIMIT = 100

function validateListParams(params: unknown): { limit: number; offset: number } {
  const raw = (params ?? {}) as Partial<ListEntriesParams>
  if (raw.limit !== undefined && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_LIMIT)) {
    throw new Error(`limit 必须是 1~${MAX_LIMIT} 的整数`)
  }
  if (raw.offset !== undefined && (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0)) {
    throw new Error('offset 必须是非负整数')
  }
  return {
    limit: raw.limit ?? DEFAULT_LIMIT,
    offset: raw.offset ?? 0
  }
}

/** 注册 ledger 域 IPC 通道（roadmap「IPC 契约」：类型唯一来源 ipc.ts → preload 白名单 → main handler） */
export function registerLedgerHandlers(ipc: IpcRegistrar, deps: LedgerDeps): void {
  ipc.handle('ledger:refresh-index', async (): Promise<RefreshResult> => {
    return refreshIndex(deps.db, deps.engine, deps.ledgerPath)
  })

  ipc.handle('ledger:status', () => {
    return getLedgerStatus(deps.db)
  })

  // async 而非同步返回：校验抛错转为 rejected promise，测试与 ipcMain.handle 语义一致
  // （ipcMain.handle 对同步 throw 同样转为 invoke 拒绝，两者对调用方无差别）
  ipc.handle('ledger:list-entries', async (_event: unknown, params: unknown) => {
    const { limit, offset } = validateListParams(params)
    return listEntries(deps.db, limit, offset)
  })
}
