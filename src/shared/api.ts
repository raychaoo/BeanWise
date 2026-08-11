import type {
  AddEntryParams,
  AddEntryResult,
  AiParseResult,
  AiStatus,
  ConfigureSyncParams,
  ConfigureSyncResult,
  LedgerStatus,
  ListAccountsResult,
  ListEntriesParams,
  ListEntriesResult,
  ReadFileResult,
  RefreshResult,
  ResolveConflictParams,
  ResolveConflictResult,
  SaveAiConfigParams,
  SaveAiConfigResult,
  SaveFileParams,
  SaveFileResult,
  SyncResult,
  SyncStatus
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
  /** git 同步状态（未配置 → configured:false） */
  getSyncStatus(): Promise<SyncStatus>
  /** 配置同步：测试连接 → 首同步（场景 A/B/C）→ 返回状态；场景 C 不一致 → conflict 三路快照 */
  configureSync(params: ConfigureSyncParams): Promise<ConfigureSyncResult>
  /** 保存后自动触发（渲染端 fire-and-forget）：commit → fetch → diff3 合并 → push */
  pushLedger(): Promise<SyncResult>
  /** 手动拉取：fetch → diff3 合并 → 工作区更新 + 索引重建 */
  pullLedger(): Promise<SyncResult>
  /** 三路合并结果提交：校验落盘 → commit → push → 索引重建 */
  resolveSyncConflict(params: ResolveConflictParams): Promise<ResolveConflictResult>
  /** 清除同步配置与 PAT */
  clearSync(): Promise<{ ok: boolean }>
  /** AI 配置状态（不含 Key——渲染端永不接触密钥） */
  getAiStatus(): Promise<AiStatus>
  /** 配置 DeepSeek API Key（safeStorage 加密，仅主进程持有） */
  saveAiConfig(params: SaveAiConfigParams): Promise<SaveAiConfigResult>
  /** 清除 AI 配置与 Key */
  clearAiConfig(): Promise<{ ok: boolean }>
  /** 自然语言 → 结构化草稿（主进程代理 + 本地 schema 校验，非法输出拒绝） */
  parseAiEntry(text: string): Promise<AiParseResult>
}
