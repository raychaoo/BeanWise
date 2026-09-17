# 通用 Excel 流水导入（M10）

> 目标：让用户导入任意 xlsx / csv 流水（银行卡、支付宝、第三方对账单等），经「列映射 + 账户映射」两层
> 映射生成 Beancount 复式记账并落盘。复用微信导入已验证的落盘链路（open 校正、原子写入、索引重建、
> 账户库同步），微信导入保持不动。

## 1. 范围

**做**
- 任意 xlsx（exceljs，已有依赖）、旧版 .xls（SheetJS xlsx@0.20，Node fs 读 buffer 后解析）、csv（UTF-8 / UTF-8 BOM / GBK 编码，主进程 TextDecoder('gbk') 零新依赖）
- 文字版 PDF 流水（pdfjs-dist 按列位置抽取，招商银行版式已验证；换行单元格/重复表头/页脚自动处理）
- 列映射：Excel 列 → 标准字段（自动建议 + 手动微调）
- 方向判定：方向列 / 金额正负 / 关键词 三选一
- 账户映射：复用 WechatMappingConfig 模型（键 → 账户 + 兜底）
- 新交易账户（新银行卡 / 新充值渠道等未映射支付方式键）检测与处理（策略 C，见 §4.5）
- 新交易类型键检测：preview 按实际导入行聚合未映射的交易类型键（支出/收入/退款），关键词建议账户，
  用户确认后写回模板（不再静默进兜底，见 §4.9）
- 去重：; beanwise-import: <source>:<rowId>（同来源）+ ; beanwise-fp: <fingerprint>（跨来源）双标记；与 ; wechat-pay-id: 互不干扰
- 多份导入模板持久化（每工作目录一份配置，如「招商银行信用卡」「支付宝」）

**不做（后续）**
- 按对方/商品关键字自动归类（麦当劳→餐饮）；M10 只做键值映射 + 兜底
- 微信导入重构为通用模板（保持独立，后续收敛）
- 导入后修改/回滚已导入交易

## 2. 现状与复用

微信导入已打通全链路（未提交在制品 src/main/wechat/、ipc-handlers-wechat.ts）：

| 环节 | 现有实现 | M10 处置 |
|---|---|---|
| 解析 | wechat/parser.ts（严格绑定微信 11 列表头） | 新增 xcel/parser.ts（通用列映射） |
| 双行生成 | wechat/import-builder.ts | 复用（标准行结构对齐） |
| open 校正 | wechat/open-normalizer.ts 
ormalizeAccountOpens | 直接复用 |
| 原子落盘 | ledger-writer.ts writeLedgerChecked | 直接复用 |
| 索引重建 | index-builder.ts 
efreshIndex | 直接复用 |
| 账户库同步 | wechat/account-sync.ts | 泛化显示名生成后复用 |
| 写锁 | write-lock.ts | 复用 |
| 双行配对校验 | shared/account.ts | 复用 |

## 3. 总体数据流

`
Excel 文件
  │ excel:choose           文件选择（xlsx / csv）
  ▼
  │ excel:parse            读 sheet 列表 / 列头，自动定位表头行，给出列映射建议 + 样例行
  │                        用户：选 sheet → 确认/调整列映射 → 选方向规则
  ▼
  │ excel:preview          应用列映射 + 方向判定 + 账户映射 → 标准行 + 新交易账户检测 + 新交易类型键检测
  │                        用户：处理新账户 / 勾选待导入行 / 二次确认兜底
  ▼
  │ excel:import           按 rowId 重新解析 → 生成双行 → open 校正 → 原子落盘 → 索引重建 → 账户库同步
  ▼
账本 main.beancount
`

## 4. 核心设计

### 4.1 标准字段（NormalizedImportRow）

`	s
interface NormalizedImportRow {
  rowNumber: number        // Excel 行号（错误提示用）
  date: string             // YYYY-MM-DD
  time?: string            // HH:mm:ss
  transactionType: string  // 类型列值（账户映射键）
  counterparty: string     // 对方（payee）
  product: string          // 商品/摘要（narration）
  kind: 'expense' | 'income' | 'neutral'
  amount: string           // 正数十进制字符串（复用 amountToDecimal）
  paymentMethod: string    // 支付方式/来源键（新交易账户检测键）
  status: string
  rowId: string            // 去重 id（单号列 或 字段 hash）
  expenseAccount: string
  sourceAccount: string
}
`

### 4.2 列映射（Excel 列 → 标准字段）

`	s
interface ExcelFieldMapping {
  dateColumn?: string; amountColumn?: string
  ioColumn?: string; typeColumn?: string; counterpartyColumn?: string
  productColumn?: string; methodColumn?: string; statusColumn?: string
  rowIdColumn?: string; noteColumn?: string
}
`

- 必选：日期、金额、方向；其余可选（缺省空串，进 payee/narration 时省略）。
- 自动建议：对表头行单元格做模糊匹配（常见中英文列名：交易时间/日期/金额/收/支/收入/支出/对方/商户/商品/摘要/支付方式/单号/备注…），命中打勾，用户可下拉改。
- 表头行自动检测：在前 N 行找「含 ≥2 个日期/金额等关键词」的行；检测失败要求用户手选。

### 4.3 方向判定

`	s
interface ExcelDirectionRule {
  mode: 'column' | 'amountSign' | 'keywords'
  positiveAs?: 'income' | 'expense'   // amountSign：金额正负对应的方向
  neutralKeywords?: string[]          // 充值/提现/互转 等
}
`

- column：ioColumn 值映射（收/支、收入/支出、+/−、D/C），未识别 → 报行错误。
- 补充：方向列无法识别 / 关键词模式未命中时，按交易类型文本中的明确收支关键词推断
  （代发工资/工资/退款/利息/收款/入账/报销 → 收入；消费/支出/付款/还款/缴费/购物/代扣 → 支出）；
  转入/转出/充值/提现等歧义词不推断，仍走默认。默认收入映射含 代发工资/代发款项/工资 → Income:Salary。
- mountSign：金额正 → positiveAs，负 → 另一侧（金额归一化为正数）。
- keywords：类型/摘要含 neutralKeywords → neutral；否则按默认方向。

### 4.4 账户映射（复用 WechatMappingConfig）

- 完全复用四张表 + 四个兜底：xpenseByKey（支出科目）、incomeByKey（收入/退款科目）、
  sourceByMethod（来源资产）、cashAccountByMethod（中性另一侧资产）。
- 「键」不再固定为微信交易类型，而是列映射后的任意值（类型列 / 方式列）。
- 命中顺序：精确键 → 兜底；账户格式校验沿用 /^[A-Z]\S*:\S*$/。

### 4.5 新交易账户检测与处理（策略 C：默认允许 + 强提示，可开严格模式）

**检测（preview 阶段，所有行含中性行）**
- 收集 paymentMethod 键聚合：键 → {笔数, 金额合计}；
- 比对 sourceByMethod / cashAccountByMethod：
  - 已映射 → 正常；
  - 未映射 + 账户库名称模糊匹配命中（如「招商银行」→ Assets:Bank:CCB）→ 建议归位；
  - 未映射 + 无匹配 → **新交易账户**。

**预览交互（「新交易账户」区块）**
- 每行：键 | 笔数 | 金额合计 | 处理方式；
- 处理方式下拉四选：选已有账户 / 输入新账户路径（自动建议 Assets:Bank:ICBC）/ 保持兜底（红色警告）/ 排除这些行；
- 处理结果写回模板 ccountMapping（sourceByMethod / cashAccountByMethod），持久化。

**导入策略（C 混合）**
- 默认：存在未处理新账户 → 预览红色标记 + 导入按钮二次确认，确认后进兜底；
- 严格模式（模板 strictNewAccounts: true）：存在未处理新账户 → 阻塞导入，逐项处理完才能导。

**落盘**
- 新账户路径由现有链路自动处理：
ormalizeAccountOpens 补 open（minDate）→ 导入后
  syncAccountsToConfig 自动进 ccounts.json（显示名 = 键，description「流水导入」）。
- 同名键去重：同键多笔只处理一次；不同键映射同路径不重复建账户（现有 Set 逻辑）。

### 4.6 去重（同来源 rowId + 跨来源内容指纹，两级）

**同来源（防同一模板重复导同一文件 / 时间区间重叠）**

```ts
// 账本标记行
; beanwise-import: <source>:<rowId>
```

- source = 模板 id（如 cmb-credit）；rowId = 单号列值，或
  sha256(date|counterparty|amount|type) 截断 16 位。
- 提取与比对：`extractBeanwiseImportIds`（`^;\s*beanwise-import:\s*(\S+)\s*$`）。
- `; wechat-pay-id:` 保留兼容，两域互不干扰。

**跨来源（微信账单 / 支付宝账单 / 银行卡流水里同一笔交易互相识别，防重复）**

```ts
; beanwise-fp: <fingerprint>
```

- fingerprint = sha256(date|counterparty|amount|kind) 截断 16 位，**不含来源 / 单号 / 支付方式**；
  金额去小数尾（17.40→17.4）、对方去空白、日期只取 YYYY-MM-DD（忽略时分秒），保证跨来源一致。
- 提取与计数：`extractBeanwiseFingerprintCounts`（Map<fp, count>，账本已有同指纹笔数）。
- 三级判定（preview 每行 dupState）：
  - `exact`：同 source:rowId 已导入 → 默认跳过；
  - `suspect`：账本 1 笔 + 文件 1 笔同指纹（1 对 1，极可能是同一笔）→ 默认跳过，可手动勾选保留；
  - `confirm`：账本或文件任一侧同指纹 ≥2 笔（可能是同日同额的真实交易）→ 默认保留，人工核对；
  - `none`：正常导入。
- 微信导入（wechat/import-builder）同样写 beanwise-fp，保证「先导微信/支付宝、后导银行卡流水」
  的顺序下，绑卡支付自动被识别为疑似重复跳过。
- 策略「宁漏勿误」：对不上的（如银行流水把对方记成「财付通」、微信记「美团」）允许重复导入，
  绝不因匹配过宽误删真实交易。
### 4.7 模板持久化

- 每工作目录一份 <workspace>/.beanwise/excel-import-templates.json（JsonExcelTemplateStore，写法同 wechat/config-store.ts）。
- **M11 起随 git 同步**（模板属「重建成本高的纯用户数据」，换电脑不该重配）：保存/删除/导入成功后自动 push；两侧都改过时按 `source`（去重标记 `<source>:<rowId>` 的前缀，跨机器同源模板必须收敛为一条，故不能按随机生成的 `id`）做三路结构化并集，只有同一 source 两侧改成不同内容才要求用户在冲突视图二选一。
- 模板结构：

`	s
interface ExcelImportTemplate {
  id: string
  name: string                    // 展示名，如「招商银行信用卡」
  source: string                  // 去重 source 标识
  headerRow?: number              // 0 = 自动检测
  sheetName?: string              // 固定 sheet（可选）
  fieldMapping: ExcelFieldMapping
  directionRule: ExcelDirectionRule
  accountMapping: WechatMappingConfig   // 复用
  strictNewAccounts: boolean
}
`

- 首次配好保存为模板；后续导入同类型文件直接选模板一键 preview。
- 微信导入配置可视为内置模板的雏形（M10 不做合并）。

### 4.8 PDF 支持（文字版银行对账单，通用版式）

- `readGrid` 新增 `.pdf` 分支：动态 `import('./pdf')`（pdfjs-dist 不进主包首屏），不改变既有调用方。
- `src/main/excel/pdf.ts` `readPdfGrid`（通用识别，已验证招行 / 交行）：
  - 表头行 = 含 ≥3 个列名关键词、且同时含「日期」「金额」的行（中文表头）；日期列 = 表头名含「日期」的列；
  - 数据行 = 日期列匹配 YYYY-MM-DD；无日期片段按「最近的主行」归并（换行对方/摘要）；
  - 跳过：表头上方元信息、重复表头、英文副表头（首行数据前的纯英文行）、页脚页码、
    页尾提示/汇总块（温馨提示/验真/打印完毕/汇总/分隔线/星号线）。
- 产物 = [表头行, ...数据行]，与 xlsx/csv 走同一套列映射 / 方向判定 / 账户映射 / 去重管线。
- 列名词表补充「交易摘要」「对手信息」等，便于流水表自动建议列映射。
- 方向判定 column 模式按银行惯例：C/贷/credit → 收入，D/借/debit → 支出（2026-08-22 修正）。
- 已知限制：稠密版式（如交行）换行片段可能串到相邻列；扫描件无文本层，
  抛「未能从 PDF 中识别流水表格」提示转 xlsx/csv。
### 4.9 新交易类型键检测（按实际导入数据创建映射）

**动机**：账户映射默认种子是微信/银行卡硬编码键（商户消费、美团平台商户-退款…），真实流水出现未映射类型键
（手续费、利息、退款等）会静默进兜底（Expenses:Uncategorized / Income:Other），无法按实际数据建映射。

**检测（preview 阶段）**
- 按行聚合 transactionType：id = `<kind>:<key>`（同一类型文本可同时存在支出/收入两条映射），
  排除 neutral 行；已映射键（expenseByType / incomeByType 命中）不出现；
- 建议账户 `suggestTypeAccount`：关键词启发式（退款→Income:Refund、利息→Income:Interest、
  手续费→Expenses:Fee、消费/购物→Expenses:Shopping、缴费→Expenses:Utilities 等），未命中返回空串。

**预览交互（「新交易类型」区块）**
- 每行：类型键 | 方向 | 笔数 | 金额合计 | 建议账户 | 处理方式；
- 处理方式三选：使用指定账户（默认建议账户，可改）/ 保持兜底（橙色警告）/ 排除这些行；
- 处理结果写回模板 accountMapping（expenseByType / incomeByType），持久化；导入按最终映射记账。

**导入策略**
- 默认：未处理新类型键 → 强提示，确认后进兜底；
- 严格模式（strictNewAccounts: true）：未处理新类型键同样阻塞导入。

## 5. IPC 契约（excel 域）

通道命名沿用 {domain}:{action}；类型唯一来源 src/shared/ipc.ts。

| 通道 | params | result 要点 |
|---|---|---|
| xcel:choose | 无 | {ok, canceled?, path?, message?}（.xlsx / .csv） |
| xcel:parse | {path, template?} | {ok, sheets?: string[], headerRow?, columns: string[], suggestedMapping?, sampleRows?, message?}（文件级识别，不落账） |
| xcel:preview | {path, template} | {ok, rows: NormalizedPreviewRow[], newAccounts: [{key, count, amount, resolution}], newTypes: [{id, key, kind, count, amount, suggestedAccount, resolution}], totals, message?} |
| xcel:import | {path, template, rowIds: string[]} | {ok, imported, skipped, status, entryCount, errorCount, message?}（写锁内：解析 → 生成 → open 校正 → 原子落盘 → 索引重建 → 账户库同步） |
| xcel:get-templates | 无 | {ok, templates: ExcelImportTemplate[]} |
| xcel:save-template | {template} | {ok, template?, message?}（id 空 → 新建，否则覆盖） |
| xcel:delete-template | {id} | {ok, message?} |

## 6. 目录与文件清单

**shared / preload**
- src/shared/ipc.ts：ExcelFieldMapping / ExcelDirectionRule / ExcelImportTemplate / NormalizedPreviewRow / NewAccountInfo 及 7 通道入参出参
- src/shared/api.ts + src/preload/index.ts：白名单 API（仿 wechat 域）

**主进程**
- src/main/excel/parser.ts：读文件（xlsx / csv + 编码探测）、表头行检测、列映射应用、方向判定、金额归一化（复用 mountToDecimal）、rowId 生成、新交易账户检测
- src/main/excel/import-builder.ts：标准行 → 双行草稿 + eanwise-import 标记（对齐 wechat builder 输出）
- src/main/excel/config-store.ts：JsonExcelTemplateStore（模板 CRUD + 校验）
- src/main/excel/account-label.ts：通用显示名生成（由导入映射反查，Excel 专属）
- src/main/ipc-handlers-excel.ts：7 通道注册（复用 withWriteLock / writeLedgerChecked / 
efreshIndex）

**渲染端**
- src/renderer/src/views/ExcelImportPanel.tsx：选文件 → 选模板/新建 → 解析 → 列映射 → 预览 → 导入
- src/renderer/src/views/ExcelColumnMappingModal.tsx：列映射 + 方向规则交互
- src/renderer/src/views/ExcelAccountMappingModal.tsx：账户映射
- src/renderer/src/views/ExcelNewAccountSection.tsx：新交易账户处理区块
- src/renderer/src/views/ExcelNewTypeSection.tsx：新交易类型键处理区块

## 7. 边界

- 不做关键字自动归类、导入回滚、多币种自动折算（沿用 CNY 默认 + currency 参数）
- 扫描件 PDF 不抽取（提示先转 xlsx/csv）
- csv 编码仅支持 UTF-8 / UTF-8 BOM / GBK；其他编码报错提示转存
- 一次只处理一个工作表（parse 返回 sheet 列表，用户选一个）

## 8. 验收标准

1. 导入非微信 xlsx（含 GBK csv）→ 列映射自动建议可微调 → 预览 → 导入 → 账本出现正确双行（金额十进制、方向正确、open 已校正）
2. 出现新银行卡/新充值渠道 → 预览「新交易账户」区块列出 → 处理后正确归位；严格模式下未处理阻塞导入；默认模式二次确认可进兜底
2.5 出现未映射交易类型键 → 预览「新交易类型」区块按实际数据列出（含建议账户）→ 处理后按指定账户记账并写入模板
3. 同一文件重复导入 → 去重跳过；不同来源（微信账单 vs 银行卡流水）同一笔 → 疑似重复默认跳过，可手动保留
4. 新账户自动进 ccounts.json（显示名 = 键，可改名）
5. 
pm run typecheck + 
pm run test:unit 绿；微信导入单测/E2E 回归全绿

## 9. 测试计划

- 单测（vitest，仿 ipc-handlers-wechat.test.ts / wechat/parser 现有测试）：
  表头行检测、列映射建议、方向判定三模式、金额归一化、rowId 生成、新交易账户分类、新交易类型键检测、builder 双行生成、
  config-store 模板 CRUD、编码探测（GBK fixture）
- E2E（Playwright）：选文件 → 列映射 → 预览 → 导入全链路；新交易账户处理；重复导入去重
