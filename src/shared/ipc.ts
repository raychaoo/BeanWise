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
  | 'accounts:get' | 'accounts:save'
  | 'workspace:get-status' | 'workspace:choose' | 'workspace:open' | 'workspace:recents'
  | 'sync:get-status' | 'sync:configure' | 'sync:push' | 'sync:pull'
  | 'sync:resolve-conflict' | 'sync:clear'
  | 'ai:get-status' | 'ai:save-config' | 'ai:clear-config' | 'ai:parse'
  | 'report:net-worth' | 'report:balances' | 'report:income-expense'
  | 'update:check' | 'update:status' | 'update:install'

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

/** 通用账户条目：name 为中文显示名，value 为 Beancount 账户路径（如 Assets:Bank:CNB） */
export interface AccountEntry {
  /** 自增主键，创建后不可编辑 */
  id: number
  /** 中文显示名（录入页下拉框 label） */
  name: string
  /** Beancount 账户路径（提交到账本的实际值），创建后不可编辑 */
  value: string
  /** 用途说明（账户设置列表中展示） */
  description?: string
}

/** accounts:save 入参 */
export interface SaveAccountsParams {
  accounts: AccountEntry[]
}

/** accounts:get / accounts:save 结果 */
export interface AccountsResult {
  ok: boolean
  accounts?: AccountEntry[]
  message?: string
}

/** git 同步配置（不含 PAT——PAT 只存主进程 safeStorage） */
export interface SyncConfig {
  repoUrl: string
  /** 固定 'main'（GitHub 默认分支） */
  branch: string
  /** 场景 C 接管（unrelated histories）→ resolve/push 需 force */
  adopted?: boolean
  lastSyncAt?: number | null
  lastError?: string | null
}

/** sync:get-status 结果（未配置 → configured:false） */
export interface SyncStatus {
  configured: boolean
  repoUrl?: string
  branch?: string
  lastSyncAt?: number | null
  lastError?: string | null
  /** 同步进行中（push/pull/configure 互斥标志） */
  syncing: boolean
}

/** sync:configure 入参（PAT 仅经此通道上传，渲染端不落 state） */
export interface ConfigureSyncParams {
  repoUrl: string
  pat: string
}

/** sync:configure 结果（conflict = 场景 C 两端内容不一致的三路快照，base 为空串） */
export interface ConfigureSyncResult {
  ok: boolean
  error?: string
  status?: SyncStatus
  conflict?: boolean
  base?: string
  ours?: string
  theirs?: string
}

/** sync:push / sync:pull 结果（conflict 时三路快照，工作区未动） */
export interface SyncResult {
  ok: boolean
  conflict?: boolean
  base?: string
  ours?: string
  theirs?: string
  message?: string
}

/** sync:resolve-conflict 入参（merged 内容，复用 20MB 上限） */
export interface ResolveConflictParams {
  content: string
}

/** sync:resolve-conflict 结果（status 为落盘后索引状态） */
export interface ResolveConflictResult {
  ok: boolean
  status?: LedgerIndexStatus
  entryCount?: number
  errorCount?: number
  message?: string
}

/** ai:get-status 结果（不含 Key——渲染端永不接触密钥） */
export interface AiStatus {
  configured: boolean
  /** 当前模型名（常量，暂无 UI 配置） */
  model: string
}

/** ai:save-config 入参（Key 仅经此通道上传，渲染端不落 state——同 sync:configure PAT 口径） */
export interface SaveAiConfigParams {
  apiKey: string
}

/** ai:save-config 结果 */
export interface SaveAiConfigResult {
  ok: boolean
  error?: string
}

/** ai:parse 入参（text ≤2000 字符，handler 校验） */
export interface AiParseParams {
  text: string
}

/** ai:parse 结果（drafts 复用 AddEntryParams[]——草稿回填 ProForm 零转换） */
export interface AiParseResult {
  ok: boolean
  drafts?: AddEntryParams[]
  /** 模型可选附带说明 */
  message?: string
  /** 失败原因（API 层 / schema 校验，中文） */
  error?: string
}

/** M8：报表域（数据源 = SQLite 索引行 → 主进程 decimal.ts 精确聚合，SQL 不 SUM） */

/** 报表粒度（月 YYYY-MM / 年 YYYY） */
export type ReportGranularity = 'month' | 'year'

/** report:net-worth 入参 */
export interface ReportNetWorthParams {
  granularity: ReportGranularity
}

/** 净资产趋势点（decimal 字符串） */
export interface NetWorthPoint {
  period: string // 'YYYY-MM' 或 'YYYY'
  assets: string
  liabilities: string
  netWorth: string // = assets + liabilities（Beancount 负债为负）
}

/** report:net-worth 结果（currency 为运营货币，其他币种已排除） */
export interface ReportNetWorthResult {
  series: NetWorthPoint[]
  currency: string
  message?: string
}

/** 账户余额树节点：balances = 子树各币种合计（rollup），children 按名称字典序 */
export interface AccountBalance {
  name: string
  balances: Array<{ currency: string; number: string }>
  children?: AccountBalance[]
}

/** report:balances 结果（全部币种分行） */
export interface ReportBalancesResult {
  accounts: AccountBalance[]
  message?: string
}

/** report:income-expense 入参（year 仅月视图有意义，缺省 = 最近有数据的年份） */
export interface ReportIncomeExpenseParams {
  granularity: ReportGranularity
  year?: number
}

/** 收支对比点（income/expense 均为正显示：income=-ΣIncome:*，expense = ΣExpenses:*（索引行支出记正数，正显示）） */
export interface IncomeExpensePoint {
  period: string
  income: string
  expense: string
}

/** report:income-expense 结果 */
export interface ReportIncomeExpenseResult {
  series: IncomeExpensePoint[]
  currency: string
  message?: string
}

/** M8：更新域（electron-updater 状态机，主进程持有） */

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

/** update:status 结果 / update:status-changed 事件载荷 */
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  /** 下载进度 0~100 */
  progress?: number
  error?: string
}

/** update:check 结果 */
export interface UpdateCheckResult {
  ok: boolean
  message?: string
}

/** update:install 结果 */
export interface UpdateInstallResult {
  ok: boolean
  message?: string
}

/** main → renderer 事件通道（更新状态推送，白名单常量） */
export const UPDATE_STATUS_CHANNEL = 'update:status-changed'

/** 工作目录域 */

/** workspace:get-status 结果（current 为 null 表示未选择） */
export interface WorkspaceStatus {
  /** 当前工作目录绝对路径（未选择 → null，渲染端显示选择界面） */
  current: string | null
  /** 当前账本文件名（固定 main.beancount） */
  ledgerFile: string
}

/** workspace:choose 结果（dialog 返回取消 → canceled:true） */
export interface ChooseFolderResult {
  ok: boolean
  canceled?: boolean
  path?: string
  message?: string
}

/** workspace:open 入参（主进程校验目录存在 + 可写） */
export interface OpenWorkspaceParams {
  path: string
}

/** workspace:open 结果 */
export interface OpenWorkspaceResult {
  ok: boolean
  message?: string
  status?: WorkspaceStatus
}

