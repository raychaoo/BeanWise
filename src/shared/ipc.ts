/**
 * IPC 通道契约（唯一来源）。命名规范：{domain}:{action} 小写 kebab，
 * 见 technical-proposal/implementation-roadmap.md「IPC 契约」。
 * M3 定稿：ledger 域三通道；业务类型在 src/main/index-builder.ts 定义并在此 re-export，
 * 保证「类型唯一来源」不被破坏（preload / renderer / main 共用）。
 */
export type IpcChannel = 'ledger:refresh-index' | 'ledger:status' | 'ledger:list-entries'

export type {
  LedgerEntryRow,
  LedgerIndexStatus,
  LedgerStatus,
  ListEntriesParams,
  ListEntriesResult,
  RefreshResult
} from '../main/index-builder'
