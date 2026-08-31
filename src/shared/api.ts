import type {
  AddEntryParams,
  AddEntryResult,
  AiParseResult,
  AiStatus,
  ConfigureSyncParams,
  ConfigureSyncResult,
  ChooseFolderResult,
  ClearLedgerResult,
  ExcelImportParams,
  ExcelImportResult,
  ExcelImportTemplate,
  ExcelParseParams,
  ExcelParseResult,
  ExcelPreviewParams,
  ExcelPreviewResult,
  ExcelTemplateDeleteResult,
  ExcelTemplateListResult,
  ExcelTemplateSaveResult,
  AccountsResult,
  SaveAccountsParams,
  LedgerStatus,
  ListAccountsResult,
  ListEntriesParams,
  ListEntriesResult,
  ReadFileResult,
  RefreshResult,
  ReportBalancesParams,
  ReportBalancesResult,
  ReportIncomeExpenseParams,
  ReportIncomeExpenseResult,
  ReportCashFlowParams,
  ReportCashFlowResult,
  ReportTrialBalanceParams,
  ReportTrialBalanceResult,
  ReportNetWorthParams,
  ReportNetWorthResult,
  ReportYearsResult,
  ResolveConflictParams,
  ResolveConflictResult,
  SaveAiConfigParams,
  SaveAiConfigResult,
  SaveFileParams,
  SaveFileResult,
  SyncResult,
  SyncStatus,
  UpdateCheckResult,
  UpdateInstallResult,
  UpdateState,
  WorkspaceOpResult,
  WorkspaceStatus
} from './ipc'

/** Preload 暴露给渲染进程的白名单 API 形状（M3 ledger 域三方法 + M4 录入链路两方法） */
export interface BeanWiseApi {
  appName: string
  /** 工作目录状态（current 为 null → 渲染端显示选择界面） */
  getWorkspaceStatus(): Promise<WorkspaceStatus>
  /** 弹出系统文件夹选择框 */
  chooseWorkspaceFolder(): Promise<ChooseFolderResult>
  /** 打开工作目录：校验 + git init + 创建账本 + 持久化 */
  openWorkspace(path: string): Promise<{ ok: boolean; message?: string; status?: WorkspaceStatus }>
  /** 最近打开的工作目录（绝对路径，最新在前，上限 10——由 WorkspaceStore.loadRecents() 保证） */
  getWorkspaceRecents(): Promise<string[]>
  /** 重命名账本目录（白名单校验 + newName 校验；current 联动重建运行时） */
  renameWorkspace(path: string, newName: string): Promise<WorkspaceOpResult>
  /** 归档账本目录：移动到 <父目录>/.beanwise-archive/（current 归档后 reload 回门控） */
  archiveWorkspace(path: string): Promise<WorkspaceOpResult>
  /** 删除账本目录（当前账本拒绝，需 UI 输入目录名确认） */
  deleteWorkspace(path: string): Promise<WorkspaceOpResult>
  /** 触发索引重建（主进程持有账本路径，渲染进程不传路径——防目录穿越） */
  refreshLedgerIndex(): Promise<RefreshResult>
  getLedgerStatus(): Promise<LedgerStatus | null>
  listLedgerEntries(params: ListEntriesParams): Promise<ListEntriesResult>
  /** 录入一笔交易：前置校验 → 落文件 → 校验 → 索引重建（M4） */
  addLedgerEntry(params: AddEntryParams): Promise<AddEntryResult>
  /** 账户列表（录入表单 AutoComplete 数据源，postings 表 DISTINCT） */
  listLedgerAccounts(): Promise<ListAccountsResult>
  /** 读取通用账户库 */
  getAccountConfig(): Promise<AccountsResult>
  /** 保存通用账户库 */
  saveAccountConfig(params: SaveAccountsParams): Promise<AccountsResult>
  /** 弹出 Excel 流水文件选择框（.xlsx / .csv） */
  chooseExcelFile(): Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }>
  /** 解析 Excel 文件结构（sheet / 表头 / 列建议），不落账 */
  parseExcelFile(params: ExcelParseParams): Promise<ExcelParseResult>
  /** 应用模板预览（列映射 + 方向 + 账户映射 + 新交易账户检测） */
  previewExcelImport(params: ExcelPreviewParams): Promise<ExcelPreviewResult>
  /** 批量导入（去重 + 原子写入 + 索引重建 + 账户库同步） */
  importExcel(params: ExcelImportParams): Promise<ExcelImportResult>
  /** 读取导入模板列表 */
  getExcelTemplates(): Promise<ExcelTemplateListResult>
  /** 保存模板（id 空 → 新建） */
  saveExcelTemplate(template: ExcelImportTemplate): Promise<ExcelTemplateSaveResult>
  /** 删除模板 */
  deleteExcelTemplate(id: string): Promise<ExcelTemplateDeleteResult>
  /** 读账本全文（编辑器基线；路径主进程持有） */
  readLedgerFile(): Promise<ReadFileResult>
  /** 整文件覆盖保存：指纹比对 → tmp 校验 → rename 原子替换 → 索引重建 */
  saveLedgerFile(params: SaveFileParams): Promise<SaveFileResult>
  /** 清空账本：清空文件 → 校验 → 索引重建（账户设置保留） */
  clearLedger(): Promise<ClearLedgerResult>
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
  /** 净资产趋势（SQLite 精确聚合，运营货币；startYear/endYear 筛选输出点，累计含全历史） */
  getNetWorthReport(params: ReportNetWorthParams): Promise<ReportNetWorthResult>
  /** 账户余额树（全部币种分行；endYear 筛选 → 截至该年末的余额快照） */
  getBalancesReport(params?: ReportBalancesParams): Promise<ReportBalancesResult>
  /** 收支对比（income/expense 正显示；startYear/endYear 筛选范围） */
  getIncomeExpenseReport(params: ReportIncomeExpenseParams): Promise<ReportIncomeExpenseResult>
  /** 账本全量年份范围（供报表年份下拉选项，不随筛选变化） */
  getReportYears(): Promise<ReportYearsResult>
  /** 三栏式科目余额表（期初/发生/期末；dateFrom/dateTo 为 YYYY-MM-DD，缺省全量） */
  getTrialBalanceReport(params?: ReportTrialBalanceParams): Promise<ReportTrialBalanceResult>
  /** 现金流量表（口径：Assets 顶层组全部账户视为资金池，池内互转不计；运营货币） */
  getCashFlowReport(params: ReportCashFlowParams): Promise<ReportCashFlowResult>
  checkForUpdates(): Promise<UpdateCheckResult>
  /** 当前更新状态（idle/checking/available/downloading/downloaded/error） */
  getUpdateStatus(): Promise<UpdateState>
  /** 下载完成后安装并重启 */
  installUpdate(): Promise<UpdateInstallResult>
  /** 订阅更新状态推送（main → renderer 事件），返回取消订阅函数 */
  onUpdateStatusChanged(cb: (state: UpdateState) => void): () => void
}
