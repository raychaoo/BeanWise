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
  | 'ledger:add-entry' | 'ledger:list-accounts' | 'ledger:read-file' | 'ledger:save-file'

/** ledger:read-file 结果（ENOENT → ok:false + message，编辑器 Empty 态） */
export interface ReadFileResult {
  ok: boolean
  /** 文件全文（utf8） */
  content?: string
  /** 文件 sha256 hex（打开时基线，保存时比对） */
  fingerprint?: string
  message?: string
}

/** ledger:save-file 入参 */
export interface SaveFileParams {
  content: string
  /** 打开时指纹（sha256 hex）：与磁盘现状不一致 → 外部修改冲突，拒绝落盘 */
  expectedFingerprint: string
}

/** ledger:save-file 结果 */
export interface SaveFileResult {
  ok: boolean
  /** true = 外部修改冲突，未落盘；diskContent/diskFingerprint 为同一次读取快照 */
  conflict?: boolean
  diskContent?: string
  diskFingerprint?: string
  /** 保存成功后新文件指纹（渲染端更新基线） */
  fingerprint?: string
  status?: LedgerIndexStatus
  entryCount?: number
  errorCount?: number
  message?: string
}

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
