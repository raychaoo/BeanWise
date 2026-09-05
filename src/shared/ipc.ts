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
  ListEntriesFilters,
  ListEntriesParams,
  ListEntriesResult,
  RefreshResult
} from '../main/core/index-builder'

export type {
  LedgerEntryRow,
  LedgerIndexStatus,
  LedgerStatus,
  ListEntriesFilters,
  ListEntriesParams,
  ListEntriesResult,
  RefreshResult
}

export type IpcChannel = 'ledger:refresh-index' | 'ledger:status' | 'ledger:list-entries'
  | 'ledger:add-entry' | 'ledger:list-accounts' | 'ledger:read-file' | 'ledger:save-file' | 'ledger:clear'
  | 'accounts:get' | 'accounts:save'
  | 'excel:choose' | 'excel:parse' | 'excel:preview' | 'excel:import' | 'excel:get-templates' | 'excel:save-template' | 'excel:delete-template'
  | 'workspace:get-status' | 'workspace:choose' | 'workspace:open' | 'workspace:recents'
  | 'workspace:rename' | 'workspace:archive' | 'workspace:delete'
  | 'sync:get-status' | 'sync:configure' | 'sync:push' | 'sync:pull'
  | 'sync:resolve-conflict' | 'sync:clear'
  | 'ai:get-status' | 'ai:save-config' | 'ai:clear-config' | 'ai:parse'
  | 'report:net-worth' | 'report:balances' | 'report:income-expense' | 'report:years' | 'report:trial-balance' | 'report:cash-flow' | 'report:breakdown' | 'report:export-pdf'
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

/** ledger:clear 结果（清空账本后索引重建） */
export interface ClearLedgerResult {
  ok: boolean
  message?: string
  status?: LedgerIndexStatus
  entryCount?: number
  errorCount?: number
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
  /** 停用后不进录入下拉；缺省视为启用（批次 I：过滤发生在渲染端 mergeAccountOptions） */
  enabled?: boolean
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

/** 通用导入账户映射：交易类型 → 支出/收入账户、支付方式 → 来源/现金账户 + 兜底（Excel 流水导入用）。 */
export interface AccountMappingConfig {
  expenseByType: Record<string, string>
  /** 收入行（含退款类）交易类型 → Income 账户 */
  incomeByType: Record<string, string>
  sourceByMethod: Record<string, string>
  /** 中性交易（提现/充值/互转）的另一侧资产账户 */
  cashAccountByMethod: Record<string, string>
  fallbackExpenseAccount: string
  fallbackSourceAccount: string
  fallbackIncomeAccount: string
  fallbackCashAccount: string
}

/** M10：通用 Excel 流水导入（独立 excel 域） */

/** 列映射：Excel 列头名 → 标准字段（缺省 = 未映射） */
export interface ExcelFieldMapping {
  dateColumn?: string
  amountColumn?: string
  /** 方向列（directionRule.mode === 'column' 时必填） */
  ioColumn?: string
  /** 交易类型列（账户映射的支出/收入键） */
  typeColumn?: string
  /** 交易对方列（payee） */
  counterpartyColumn?: string
  /** 商品/摘要列（narration） */
  productColumn?: string
  /** 支付方式/来源键列（新交易账户检测键） */
  methodColumn?: string
  statusColumn?: string
  /** 去重单号列；缺省用 日期+对方+金额 hash */
  rowIdColumn?: string
  noteColumn?: string
}

export type ExcelDirectionMode = 'column' | 'amountSign' | 'keywords'

export interface ExcelDirectionRule {
  mode: ExcelDirectionMode
  /** amountSign：金额正数对应的方向 */
  positiveAs?: 'income' | 'expense'
  /** keywords：类型/摘要命中即中性（充值/提现/互转），否则按 defaultKind */
  neutralKeywords?: string[]
  /** keywords 模式：未命中关键词时的默认方向 */
  defaultKind?: 'expense' | 'income'
}

/** 通用 Excel 导入模板（每工作目录多份，持久化于 .beanwise/excel-import-templates.json） */
export interface ExcelImportTemplate {
  /** 模板唯一 id（去重 source 标识），新建时由主进程生成 */
  id: string
  /** 展示名，如「招商银行信用卡」 */
  name: string
  /** 去重标记前缀（beanwise-import: <source>:<rowId>） */
  source: string
  /** 表头行（1 基）；0/缺省 = 自动检测 */
  headerRow?: number
  /** 固定工作表名；缺省 = 第一个工作表 */
  sheetName?: string
  fieldMapping: ExcelFieldMapping
  directionRule: ExcelDirectionRule
  /** 账户映射：交易类型/支付方式 → 账户四表 + 兜底模型 */
  accountMapping: AccountMappingConfig
  /** 策略 C 严格模式：存在未处理新交易账户 → 阻塞导入 */
  strictNewAccounts?: boolean
}

/** excel:preview 预览行 */
export interface ExcelPreviewRow {
  rowNumber: number
  date: string
  time: string
  transactionType: string
  counterparty: string
  product: string
  kind: 'expense' | 'income' | 'neutral'
  amount: string
  paymentMethod: string
  status: string
  rowId: string
  alreadyImported: boolean
  /** 跨来源去重指纹（date|amount|counterparty|kind 哈希，不含来源/单号） */
  fingerprint: string
  /** 去重状态：none 正常 / exact 同来源已导入 / suspect 疑似跨来源重复 / confirm 需人工确认 */
  dupState: 'none' | 'exact' | 'suspect' | 'confirm'
  expenseAccount: string
  sourceAccount: string
}

export type NewAccountResolution = 'fallback' | 'existing' | 'new' | 'exclude'

/** 未映射支付方式键（新交易账户）检测结果：同支付方式按交易类型拆分为多条（支付方式@交易类型） */
export interface ExcelNewAccountInfo {
  /** 唯一键：<支付方式>@<交易类型>（交易类型为空退化为支付方式；写入 sourceByMethod/cashAccountByMethod） */
  id: string
  /** 支付方式文本（Excel 支付方式列原值） */
  key: string
  /** 区分该支付方式的交易类型文本（无则空串） */
  type: string
  count: number
  /** 金额合计（十进制字符串） */
  amount: string
  /** 建议账户路径（账户库模糊命中；无则空串） */
  suggestedAccount: string
  /** 当前解析将采用的处置（未处理 = fallback） */
  resolution: NewAccountResolution
}


/** 未映射交易类型键的处置方式（mapped=按指定账户记账 / fallback=兜底 / exclude=排除这些行） */
export type TypeMappingResolution = 'mapped' | 'fallback' | 'exclude'

/** 未映射交易类型键（新支出/收入/退款类型）检测结果：同交易类型按支付方式拆分为多条（交易类型@支付方式） */
export interface ExcelNewTypeInfo {
  /** 唯一键：<kind>:<交易类型>@<支付方式>（支付方式为空退化为 <kind>:<交易类型>） */
  id: string
  /** 交易类型文本（Excel 类型列原值） */
  key: string
  /** 区分该交易类型的支付方式文本（无则空串） */
  method: string
  kind: 'expense' | 'income'
  count: number
  /** 金额合计（十进制字符串） */
  amount: string
  /** 建议账户路径（关键词启发式；无则空串） */
  suggestedAccount: string
  /** 当前解析将采用的处置（未处理 = fallback） */
  resolution: TypeMappingResolution
}

export interface ExcelPreviewTotals {
  total: number
  expense: number
  income: number
  neutral: number
  alreadyImported: number
  /** 疑似跨来源重复行数（默认跳过） */
  suspect: number
  /** 需人工确认行数（默认保留，提示核对） */
  confirm: number
}

/** excel:parse 入参（path 来自 choose；template 可带已有映射做建议增强） */
export interface ExcelParseParams {
  path: string
  template?: ExcelImportTemplate
}

export interface ExcelParseResult {
  ok: boolean
  message?: string
  sheets?: string[]
  /** 检测/指定的表头行（1 基） */
  headerRow?: number
  columns?: string[]
  suggestedMapping?: ExcelFieldMapping
  /** 表头后前 3 行样例行（原始值，渲染端核对用） */
  sampleRows?: string[][]
}

/** excel:preview 入参（path + 完整模板；账户映射含用户已处理的新账户归位） */
export interface ExcelPreviewParams {
  path: string
  template: ExcelImportTemplate
}

export interface ExcelPreviewResult {
  ok: boolean
  message?: string
  rows?: ExcelPreviewRow[]
  newAccounts?: ExcelNewAccountInfo[]
  /** 未映射交易类型键（按实际导入数据聚合） */
  newTypes?: ExcelNewTypeInfo[]
  totals?: ExcelPreviewTotals
}

export interface ExcelImportParams {
  path: string
  template: ExcelImportTemplate
  rowIds: string[]
  currency?: string
}

export interface ExcelImportResult {
  ok: boolean
  message?: string
  imported?: number
  skipped?: number
  status?: LedgerIndexStatus
  entryCount?: number
  errorCount?: number
}

/** excel:get-templates 结果 */
export interface ExcelTemplateListResult {
  ok: boolean
  templates?: ExcelImportTemplate[]
  message?: string
}

/** excel:save-template 结果（id 为空 → 新建并返回分配 id 的模板） */
export interface ExcelTemplateSaveResult {
  ok: boolean
  template?: ExcelImportTemplate
  message?: string
}

/** excel:delete-template 结果 */
export interface ExcelTemplateDeleteResult {
  ok: boolean
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

/** 报表粒度（日 YYYY-MM-DD / 周 YYYY-Www（ISO）/ 月 YYYY-MM / 年 YYYY；批次 G 放开日/周） */
export type ReportGranularity = 'day' | 'week' | 'month' | 'year'

/** 报表年份范围（缺省 = 不设边界，全量数据；startYear > endYear 由 handler 校验拒绝） */
export interface ReportYearRange {
  startYear?: number
  endYear?: number
}

/** report:net-worth 入参 */
export interface ReportNetWorthParams extends ReportYearRange {
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

/** report:balances 入参（余额为「期末快照」：仅 endYear 参与过滤——截至该年末的余额，startYear 不影响余额值） */
export interface ReportBalancesParams extends ReportYearRange {}

/** report:balances 结果（全部币种分行） */
export interface ReportBalancesResult {
  accounts: AccountBalance[]
  message?: string
}

/** report:income-expense 入参（month 粒度缺省范围 = 最近有数据的年份，与旧 year 行为一致） */
export interface ReportIncomeExpenseParams extends ReportYearRange {
  granularity: ReportGranularity
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

/** report:years 结果（账本全量数据年份范围，供渲染端年份下拉选项；无数据 → min/max 均为 0） */
export interface ReportYearsResult {
  min: number
  max: number
}

/** report:trial-balance 入参（dateFrom/dateTo 均为 YYYY-MM-DD，缺省全量；dateFrom 不含——期初为之前累计） */
export interface ReportTrialBalanceParams {
  dateFrom?: string
  dateTo?: string
}

/** 三栏单元格：金额（decimal 字符串）+ 币种（每账户每币种一行，故单币种） */
export interface TrialBalanceCell {
  number: string
  currency: string
}

/** 三栏式科目余额表行：opening = dateFrom 前累计净额 / period = 区间净发生额 / closing = opening + period（Income 正显示） */
export interface TrialBalanceRow {
  name: string
  opening: TrialBalanceCell
  period: TrialBalanceCell
  closing: TrialBalanceCell
}

/** report:trial-balance 结果 */
export interface ReportTrialBalanceResult {
  rows: TrialBalanceRow[]
  message?: string
}

/** report:cash-flow 入参（granularity 必传；dateFrom/dateTo 为 YYYY-MM-DD 区间，缺省全量） */
export interface ReportCashFlowParams {
  granularity: ReportGranularity
  dateFrom?: string
  dateTo?: string
}

/** 现金流量点：inflow = 区间内非 Assets→Assets 流入；outflow = Assets→非 Assets 流出；net = inflow - outflow（decimal 字符串） */
export interface CashFlowPoint {
  period: string
  inflow: string
  outflow: string
  net: string
}

/** report:cash-flow 结果（currency 为运营货币——口径 = Assets 顶层组全部账户视为资金池，按运营货币计） */
export interface ReportCashFlowResult {
  series: CashFlowPoint[]
  currency: string
  message?: string
}

/** report:export-pdf 结果（取消保存 → ok:true 无 path；打印/写盘异常 → ok:false + message） */
export interface ExportReportPdfResult {
  ok: boolean
  path?: string
  message?: string
}

/** 支出/收入类别汇总（breakdown）：单类别，ratio 为十进制字符串 0~1（占该流向总额比例，含尾随零/前导零已规范） */
export interface BreakdownItem {
  /** 类别路径（顶层段，如 Expenses:Food → 'Expenses:Food'；Expenses:Food:Snack → 'Expenses:Food'） */
  category: string
  /** 十进制字符串金额（正显示） */
  amount: string
  /** 占该流向总额比例（十进制字符串 0~1） */
  ratio: string
}

/** report:breakdown 入参（dateFrom/dateTo YYYY-MM-DD 缺省全量；flow 指定流向；top 缺省 6，超出合并为「其他」） */
export interface ReportBreakdownParams {
  flow: 'expense' | 'income'
  dateFrom?: string
  dateTo?: string
  top?: number
}

/** report:breakdown 结果（currency 运营货币；items 按金额降序，超出 top 位合并为末位「其他」；total 为该流向总额） */
export interface ReportBreakdownResult {
  items: BreakdownItem[]
  total: string
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

/** workspace:rename 入参（newName 仅中文/字母/数字/下划线/连字符，主进程二次校验） */
export interface WorkspaceRenameParams {
  path: string
  newName: string
}

/** workspace:archive / workspace:delete 入参（仅允许 current/recents 已登记路径） */
export interface WorkspacePathParams {
  path: string
}

/** workspace:rename / archive / delete 结果（成功时 newPath 为新路径 / 归档目标路径） */
export interface WorkspaceOpResult {
  ok: boolean
  message?: string
  newPath?: string
}

