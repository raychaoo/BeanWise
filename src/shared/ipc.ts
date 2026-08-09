/**
 * IPC 通道契约（唯一来源）。命名规范：{domain}:{action} 小写 kebab，
 * 见 technical-proposal/implementation-roadmap.md「IPC 契约」。
 * M3 定稿：ledger 域三通道；索引业务类型在 src/main/index-builder.ts 定义并在此 re-export。
 * M4 定稿：新增 ledger:add-entry / ledger:list-accounts（录入链路）；纯契约类型
 * （AddEntryParams 等）直接定义于此，保证「类型唯一来源」（preload / renderer / main 共用）。
 */
import type {
  LedgerEntryRow,
  LedgerIndexStatus,
  LedgerStatus,
  ListEntriesParams,
  ListEntriesResult,
  RefreshResult
} from '../main/index-builder'

export type {
  LedgerEntryRow,
  LedgerIndexStatus,
  LedgerStatus,
  ListEntriesParams,
  ListEntriesResult,
  RefreshResult
}

export type IpcChannel = 'ledger:refresh-index' | 'ledger:status' | 'ledger:list-entries'
  | 'ledger:add-entry' | 'ledger:list-accounts'

/** 录入交易的 posting 行；金额一律十进制字符串（禁浮点，见 src/shared/decimal.ts） */
export interface AddEntryPosting {
  /** 账户全名：含冒号、首字符大写字母、无空白 */
  account: string
  /** 十进制字符串金额，正则 ^-?\d+(\.\d+)?$ */
  number: string
  /** 货币符号：非空、无空白、≤24 字符 */
  currency: string
}

/** ledger:add-entry 入参（postings 2~20 行） */
export interface AddEntryParams {
  /** YYYY-MM-DD（真实日期） */
  date: string
  flag?: '*' | '!'
  /** ≤200 字符、无控制字符（trim 后空视为缺省） */
  payee?: string
  narration?: string
  postings: AddEntryPosting[]
}

/** ledger:add-entry 结果（status 为索引重建后的状态） */
export interface AddEntryResult {
  ok: boolean
  message?: string
  status: LedgerIndexStatus
  entryCount: number
  errorCount: number
}

/** ledger:list-accounts 结果（postings 表 DISTINCT） */
export interface ListAccountsResult {
  accounts: string[]
}
