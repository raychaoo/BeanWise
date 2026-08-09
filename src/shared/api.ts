import type {
  AddEntryParams,
  AddEntryResult,
  LedgerStatus,
  ListAccountsResult,
  ListEntriesParams,
  ListEntriesResult,
  ReadFileResult,
  RefreshResult,
  SaveFileParams,
  SaveFileResult
} from './ipc'

/** Preload 暴露给渲染进程的白名单 API 形状（M3 ledger 域三方法 + M4 录入链路两方法） */
export interface BeanWiseApi {
  appName: string
  /** 触发索引重建（主进程持有账本路径，渲染进程不传路径——防目录穿越） */
  refreshLedgerIndex(): Promise<RefreshResult>
  getLedgerStatus(): Promise<LedgerStatus | null>
  listLedgerEntries(params: ListEntriesParams): Promise<ListEntriesResult>
  /** 录入一笔交易：前置校验 → 落文件 → 校验 → 索引重建（M4） */
  addLedgerEntry(params: AddEntryParams): Promise<AddEntryResult>
  /** 账户列表（录入表单 AutoComplete 数据源，postings 表 DISTINCT） */
  listLedgerAccounts(): Promise<ListAccountsResult>
  /** 读账本全文（编辑器基线；路径主进程持有） */
  readLedgerFile(): Promise<ReadFileResult>
  /** 整文件覆盖保存：指纹比对 → tmp 校验 → rename 原子替换 → 索引重建 */
  saveLedgerFile(params: SaveFileParams): Promise<SaveFileResult>
}
