import type { LedgerStatus, ListEntriesParams, ListEntriesResult, RefreshResult } from './ipc'

/** Preload 暴露给渲染进程的白名单 API 形状（M3 扩展 ledger 域三方法） */
export interface BeanWiseApi {
  appName: string
  /** 触发索引重建（主进程持有账本路径，渲染进程不传路径——防目录穿越） */
  refreshLedgerIndex(): Promise<RefreshResult>
  getLedgerStatus(): Promise<LedgerStatus | null>
  listLedgerEntries(params: ListEntriesParams): Promise<ListEntriesResult>
}
