# M8 图表报表 + 发布加固设计（Design Spec）

> 状态：定稿（2026-08-11）
> 依据：roadmap「M8 | 图表报表 + 发布加固 | M4, M5, M6, M7 | 图表渲染真实数据；升级演练；完整发布演练（tag → Release → 更新）」；CLAUDE.md「antd 锁定 5.x……M8 图表期再评估」；
> 范围裁决（2026-08-11 用户逐项确认）：报表清单 = 净资产趋势（年/月粒度切换）+ 账户余额一览（科目树）+ 月度/年度收支对比；数据源 = **SQLite 聚合**（复用 M3 索引，不经 Python）；升级演练 = **E2E 本地 mock 更新源 + 首版人工演练**；代码签名 = **放弃**（不签名发布，SmartScreen 风险接受，管线不留签名配置）；IPC 方案 A 定稿（每报表一通道 + 主进程 TS 精确聚合层，B/C 否决）。

## 1. 目标与绿灯验收

**目标**：落地报表视图（真实账本数据 → Ant Charts 图表 + 科目树表格），接通 electron-updater 升级链路（检查 → 下载 → 安装），铺好发布管线（tag → GitHub Release → latest.yml），按「无签名」口径完成发布加固。

**绿灯验收**（roadmap M8 行）：

1. 图表渲染真实数据（E2E 断言 + 手工验证）
2. 升级演练（E2E 本地 mock 源：检查到新版本 → 下载 → downloaded 状态；安装替换留首版人工）
3. 完整发布演练（tag → Release → 更新，未签名，SmartScreen 预期警告）

## 2. 技术选型（定稿）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 图表库 | **@ant-design/charts 2.6.7**（Ant Charts） | tech-stack 既定项；peer `react >=16.8.4` 满足 React 19（npm 核实），运行时仍需冒烟验证 |
| 报表数据源 | **SQLite 索引聚合**（不经 Python） | M3 索引设计目标即「按日期/账户建索引，支撑图表聚合查询」（data-consistency.md）；毫秒级、不重复解析账本文件 |
| 金额聚合精度 | **SQL 只做行筛选/排序，金额累计全部主进程 `decimal.ts` 字符串加法** | SQLite `SUM()` 对 TEXT 数值转 REAL 丢精度，违反「金额一律十进制字符串精确运算」铁律（CLAUDE.md）；行级读 + TS 精确累计在 5 万笔量级为毫秒级，无需 SQL 聚合 |
| IPC 形态 | **每报表一通道 + 纯函数聚合层**（方案 A） | 延续细粒度通道惯例（ledger:list-entries / sync:get-status）；树 rollup 与累计逻辑在 TS 比 SQL 好写且可单测；加报表 = 加一个通道 + 一个 TS 函数 |
| 升级引擎 | **electron-updater** + 主进程状态机封装 | release-pipeline 既定链路；`autoUpdater.setFeedURL` 支持 E2E 注入本地 mock 源 |
| 代码签名 | **放弃**（不配 CSC_*，electron-builder 默认无证书跳过签名） | 用户裁决；electron-updater 不校验 Authenticode，未签名包升级链路可通；SmartScreen 拦截风险记录在案 |
| antd v6 | **只评估不迁移**（查 v6 + pro-components 3.x 兼容状态 → ADR 结论） | CLAUDE.md 排期「M8 图表期再评估」；迁移动作风险大，单独成里程碑 |

## 3. 报表子系统

### 3.1 数据流

```
ReportsView → report:xxx IPC → main（Drizzle 查索引行 → report-aggregation 精确聚合）→ 图表
```

只读聚合，不经 Python；索引由既有 refresh 链路维护（Header Tag / 明细视图同链路）。索引 `status !== 'ok'` 时页面顶部警告条。

### 3.2 IPC 契约（`src/shared/ipc.ts` 类型唯一来源 → preload 白名单 → main handler）

| 通道 | params | result 要点 |
|---|---|---|
| `report:net-worth` | `{granularity: 'month'\|'year'}` | `{series: [{period, assets, liabilities, netWorth}], currency, message?}`——period：月 `YYYY-MM` / 年 `YYYY`；累计口径：截至该期末 Assets 系 / Liabilities 系累计和，netWorth = assets + liabilities |
| `report:balances` | 无 | `{accounts: [{name, number: str, currency, children?}], message?}`——叶子余额 → 按 `.` 前缀 rollup 的科目树（含中间层与根节点合计），多货币按币种分行 |
| `report:income-expense` | `{granularity, year?}` | `{series: [{period, income, expense}], currency, message?}`——income = ΣIncome:*，expense = -ΣExpenses:*（Beancount 惯例支出为负）；月视图按年取 12 个月，year 缺省为最近有数据的年份；年视图全历史按年 |

入参校验：granularity 枚举、year 为 4 位数字（仅月视图有意义），非法返回 `ok:false + message`（沿用既有错误语义）。

### 3.3 聚合层（`src/main/report-aggregation.ts`，纯函数）

- `computeNetWorth(rows, granularity)`：rows = postings（account 前缀 `Assets:%` / `Liabilities:%`，按日期排序）→ 逐行 `addDecimalStrings` 累计 → 按月/年截断为期末快照
- `buildAccountTree(rows)`：全部账户叶子余额（多货币分行）→ 按 `.` 前缀合并子科目 → 递归 rollup 父科目
- `computeIncomeExpense(rows, granularity, year?)`：`Income:*` / `Expenses:*` 前缀过滤 → 按期间分组求和（字符串加法）→ 正负号归一（income 正 / expense 负→正显示）

多货币边界：趋势图只按运营货币（`ledgerMeta.operatingCurrency` 主币）聚合，其他币种 postings 排除并在页面标注「仅运营货币」；余额树保留全部币种分行。

### 3.4 IPC handlers（`src/main/ipc-handlers-report.ts`）

Drizzle 查询（postings JOIN entries 取 date/account/units_number/units_currency，按账户前缀 + 日期排序）+ 调聚合函数 + 入参校验。查询全参数化（Drizzle prepared），无注入面。

### 3.5 渲染端

- `views/ReportsView.tsx`：顶部粒度 Segmented（月/年）+ 运营货币标注；三面板——
  - 净资产趋势：Ant Charts Line（资产 / 负债 / 净资产三序列）
  - 收支对比：Grouped Column（收入 / 支出）
  - 账户余额：antd Table 树形（children 展开）+ 各层 rollup 金额
- `stores/reports.ts`（Zustand）：三面板独立 data/loading/error + 粒度 state + 重试 action，与 ledger/sync/ai store 同构
- `App.tsx`：Sider 加「报表」菜单项（`view` 类型扩展 `'reports'`，图标 BarChartOutlined）

## 4. 升级链（electron-updater）

### 4.1 主进程（`src/main/updater.ts`）

- 依赖：`electron-updater`（新）
- 状态机：`idle / checking / available / downloading(progress) / downloaded / error`，主进程持有，事件经 `webContents.send('update:status-changed', …)` 推渲染进程
- `autoUpdater.setFeedURL`（E2E 注入 generic provider → 本地 mock 源）；生产走 electron-builder 生成的 `app-update.yml`（provider github）
- 未签名说明：electron-updater 不校验 Authenticode，未签名包升级链路可通

### 4.2 IPC 契约

| 通道 | params | result 要点 |
|---|---|---|
| `update:check` | 无 | `{ok, message?}`（触发状态机 → 检查） |
| `update:status` | 无 | `{currentVersion, status, progress?, error?}` |
| `update:install` | 无 | `{ok}`（quitAndInstall） |

事件推送：`update:status-changed`（main → renderer，白名单常量）。

### 4.3 渲染端

Header 加「更新」按钮（UpgradeOutlined）→ `views/UpdateModal.tsx`：当前版本 + 检查更新 + 下载进度条 + 错误态 + 安装按钮（沿用 AiSettingsModal / SyncSettingsModal 模式）。

### 4.4 E2E 演练（mock 更新源）

`src/main/update-test-server.ts`：进程内 HTTP 服务器（复用 git-test-server 模式）serving `latest.yml` + 安装包；E2E 注入 `setFeedURL` → 断言「检查到新版本 → 下载 → downloaded」。**边界**：E2E 不触发真实安装（quitAndInstall 会替换运行中的应用），安装环节由首版人工演练覆盖。

## 5. 发布加固（无签名版）

- CI：检查现有 GitHub Actions workflow，补 `tag v*` 触发 → 完整 Windows 构建 → GitHub Release（草稿，人工确认）→ `latest.yml` + NSIS 产物随发布；不配 `CSC_*` secrets
- electron-builder：确认无证书时默认跳过签名不失败；`latest.yml` 必随产物（易错点 #1）；`win.signAndEditExecutable` 不启用
- release-pipeline.md 更新：「签名要求」表改为「无签名口径 + SmartScreen 风险说明」，触发规则不变
- **antd v6 评估**（只评估不迁移）：查 antd v6 + @ant-design/pro-components 3.x + 图表库兼容状态 → 写 ADR 结论（升级与否 + 风险 + 建议时机）
- 新 ADR：
  - **ADR 14**：报表数据源 = SQLite 精确字符串聚合（不经 Python；SQLite SUM → REAL 丢精度故金额累计走 decimal.ts）
  - **ADR 15**：升级链 = electron-updater + setFeedURL mock 源 E2E 演练 + 无签名策略（SmartScreen 风险接受，证书到位后补签一次）

## 6. 错误处理与边界

- 索引 `status !== 'ok'` → 报表页警告条「索引异常，数据可能不完整，请重建索引」（复用 Header 重建链路）
- 空账本 / 无 postings → 面板空态 + 引导文案
- `report:*` 失败 → 面板级错误条 + 重试按钮（三面板独立，互不拖垮）
- 多货币：趋势图仅运营货币（页面标注），余额树按币种分行
- 大账本性能边界：全量行读 + TS 精确聚合，单面板毫秒级；>5 万笔基准留 ADR「待评审」列表（不阻塞 M8）
- 升级边界：网络失败 / 已最新 / 下载失败 → Modal 错误态；下载中禁用重复检查

## 7. 测试策略

- **Vitest 单测**：
  - `report-aggregation`：累计余额（月/年）、科目树 rollup、收支正负号归一、多货币过滤、空数据、无 Income/Expenses 前缀等边界
  - `ipc-handlers-report`：入参校验（非法 granularity / year）、mock 索引行 → 聚合结果
  - `updater`：mock autoUpdater 事件（checking→available→downloading→downloaded→error）驱动状态机
- **E2E**：
  - 报表视图：注入测试账本 → 打开报表页 → 断言图表/表格真实数据渲染
  - 升级演练：mock 更新源 → 检查更新 → 断言 downloaded
- **首版人工演练**（发布后）：tag v0.1.0 → Release → 装旧版 → 发 v0.1.1 → 应用内更新（未签名，SmartScreen 预期警告）

## 8. 边界（明确不做）

- 日期范围筛选器（趋势图全历史；筛选后置）
- 多币种趋势 / 汇率折算（趋势图仅运营货币）
- 预算对比、Fava 报表兼容（ADR 待评审列表）
- 自动定时检查更新（仅手动按钮；定时器后置）
- antd v6 实际迁移（仅评估 + ADR 结论）
