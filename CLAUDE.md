# CLAUDE.md

BeanWise（豆账）— Beancount 复式记
本文件为 Claude Code / AI 编程助手提供本仓库的项目上下文、常用命令与硬性约束。
请严格遵守，尤其是「关键约束」一节；不确定时先查阅本目录下的方案文档。

## 项目概览

Beancount 复式记账桌面应用（Electron 桌面端，Windows-only）。

- **核心原则**：Beancount 文件是唯一事实源（Single Source of Truth），SQLite 仅为索引缓存
- **工作目录模型**：应用按「工作目录」组织账本；每个工作目录独立持有账本文件、SQLite 索引、git 仓库与同步/账户配置，切换即重建运行时（见「工作目录数据模型」）
- **能力**：账本录入（ProForm 固定两行 + 通用账户库 + DeepSeek AI 辅助（deepseek-v4-flash），AI 未配置时入口隐藏）、校验、图表报表、GitHub 私有仓库同步、electron-updater 自动更新
- **引擎**：Python 3.11 + Beancount v3，经 PyInstaller 打包为独立二进制随应用分发
- **同步**：isomorphic-git → GitHub 私有仓库（PAT 本地化，safeStorage 加密，按工作目录隔离）

## 常用命令

```bash
npm run dev          # 启动 Vite dev + Electron
npm run typecheck    # TypeScript 严格模式检查
npm run test:unit    # Vitest 前端单测
npm run test:e2e     # Playwright Electron E2E（CI 无头环境需 xvfb-run -a）
npm run build:python # PyInstaller 打包 Python 引擎 → dist-python/
npm run dist:win     # electron-builder 构建 Windows 安装包（NSIS）
pytest python/tests  # Python Beancount 引擎测试
```

## 技术栈

- **桌面框架**：Electron · Vite · React + TypeScript（strict）
- **UI**：Ant Design（antd 5.x，**禁 v6**：@ant-design/pro-components 2.8.x peer 仅 `^4 || ^5`，v6 迁移评估留 M8；必须配 @ant-design/v5-patch-for-react-19，main.tsx 首行导入）+ ProComponents（ProForm 录入）· Ant Charts · Monaco Editor（裸 monaco-editor，worker 经 Vite `?worker` 本地打包，自研 monarch beancount 语言——M5 定稿，集成细节见「常见坑」）· Zustand 5 · 路由 react-router-dom 7（HashRouter，App.tsx ProLayout 承载；e2e 依赖菜单文本 `录入`/`明细`/`报表` 与报表默认 Tab 卡片标题，不得改名）；样式：Less 分层（`src/renderer/src/styles/`：tokens.less + base.less + layout.less + views/*.less）+ antd token 单源（`theme/tokens.ts`，与 `styles/tokens.less` 头部互指同步）
- **数据**：better-sqlite3 + Drizzle ORM（索引库每工作目录一份 `.beanwise/index.db`，可随时重建）· electron-log · electron-store（工作目录 current/recents 与 PAT/Key 密文）· Electron safeStorage · 工作目录 JSON 配置（`JsonSyncConfigStore` / `JsonAccountConfigStore`，见「工作目录数据模型」）
- **同步**：isomorphic-git（1.41.3 纯 JS，GitSync 封装——工作目录即 git 工作区、只追踪账本文件、分支固定 main；仅 http/https 传输，不支持 file:// 本地传输，测试/E2E 走进程内 smart-HTTP 服务器 `src/main/git-test-server.ts`）+ ElectronWorkspaceTokenStore（PAT 密文，按工作目录路径键隔离，仅主进程持有）+ JsonSyncConfigStore（同步配置 repoUrl/branch/adopted/lastSyncAt/lastError）
- **AI 辅助**：DeepSeek API（deepseek-v4-flash，主进程代理）+ zod 4（tool schema 单源三用：`z.toJSONSchema` → function calling parameters、`zod.parse` 本地校验、`z.infer` TS 类型）——M7 定稿，集成细节见「常见坑」；未配置 Key 时 AiEntryPanel 整入口隐藏（`rs.config` 读取 ai:get-status）
- **通用账户库 + 录入配对**：`src/shared/account.ts`（账户顶层类型判定 + 双行配对校验：两行不能同为 Income/Expenses，至少一边为资产/负债/权益）+ `<workspace>/.beanwise/accounts.json`（AccountEntry：id 自增 / name 中文显示名 / value Beancount 路径）——2026-08-22 落地，录入行下拉 = 账本已有账户 ∪ 账户库自选账户
- **报表**：@ant-design/charts（Ant Charts 2.6.x，peer `react >=16.8.4` 兼容 React 19）+ electron-updater（主进程状态机封装，`update:status-changed` 事件推送）——M8 定稿；报表数据源 = SQLite 索引聚合（不经 Python），金额累计走 decimal.ts 精确字符串运算（SQLite SUM 转 REAL 丢精度禁用）
- **引擎**：Python 3.11 + Beancount v3 · PyInstaller · stdio JSON-RPC
- **工程化**：Vitest · pytest · Playwright · electron-builder · electron-updater · GitHub Actions

## 架构与进程边界

```
渲染进程(React) → Preload(contextBridge 白名单) → 主进程(IPC 路由)
                                                     ├─ PythonSvc（stdio JSON-RPC）
                                                     ├─ GitSync（isomorphic-git，每工作目录一份仓库）
                                                     ├─ SQLite（Drizzle ORM，`.beanwise/index.db`）
                                                     └─ DeepSeek 代理（zod 4 tool 校验）
```

- **工作目录数据模型**：主进程按「工作目录」组织运行时——账本 `main.beancount`、索引 `.beanwise/index.db`、同步配置 `.beanwise/sync-config.json`、账户库 `.beanwise/accounts.json`、git 仓库 `.git` 各目录独立；`activateWorkspace` 关闭旧 db → 重建 db/GitSync/索引；`workspace:open` 校验目录 + 初始化 git + 接管/创建账本文件，成功后渲染端整页 reload
- 工作目录当前路径 + 最近打开列表（上限 10）存 electron-store（`workspace`）；路径由主进程持有，渲染进程不直接接触
- **Node ↔ Python 通信**：stdio JSON-RPC 2.0，JSONL 逐行（`\n` 分隔），方法：`ping` / `parse_file` / `parse_entries` / `validate` / `query` / `render_report` / `shutdown`（AI 解析走主进程代理，不经 Python）
- **Python 进程生命周期**：主进程 spawn 管理；异常退出按指数退避重启；`before-quit` 时优雅关闭
- **数据流**：录入/查询 Renderer → IPC → Main → Python Engine → SQLite 回填；文件变更 → 增量解析 → 重建索引（工作目录切换后自动刷新）

## IPC 域（类型唯一来源 `src/shared/ipc.ts`）

| 域 | 通道 | 说明 |
|---|---|---|
| ledger | `refresh-index` / `status` / `list-entries` / `add-entry` / `list-accounts` / `read-file` / `save-file` | 索引、录入（两行平衡校验）、编辑器全文件覆盖保存（sha256 指纹冲突检测） |
| accounts | `get` / `save` | 通用账户库维护（AccountEntry：id 自增 / name 中文显示名 / value Beancount 路径） |
| workspace | `get-status` / `choose` / `open` | 工作目录门控与切换（路径由主进程持有，防目录穿越） |
| sync | `get-status` / `configure` / `push` / `pull` / `resolve-conflict` / `clear` | GitHub 同步 + diff3 合并 + 三路冲突 UI |
| ai | `get-status` / `save-config` / `clear-config` / `parse` | DeepSeek 代理；Key 经 safeStorage，渲染端永不接触 |
| report | `net-worth` / `balances` / `income-expense` / `years` / `trial-balance` / `cash-flow` / `export-pdf` | SQLite 行 → decimal.ts 精确聚合（禁 SQL SUM）；批次 G 三通道：三栏余额表（期初/发生/期末，`trial-balance`）、现金流量表（Assets 资金池口径，池内互转不计，`cash-flow`）、PDF 导出（printToPDF + 保存对话框 + @media print 隔离，`export-pdf`） |
| update | `check` / `status` / `install` | electron-updater 状态机；事件 `update:status-changed` main→renderer |

## 关键约束（违反即 bug）

1. **Beancount 文件是唯一事实源**：所有写入先落文件、校验通过后再重建 SQLite 索引；禁止绕过文件直接写 SQLite
2. **密钥隔离**：GitHub PAT / DeepSeek API Key 只在主进程持有（safeStorage 加密），渲染进程不可见；AI 请求必须走主进程代理
3. **渲染进程不直连 Python / SQLite / git**：一律走 IPC → 主进程
4. **Beancount 锁定 v3**：禁止引入 v2 语法 / API，两者差异大不可混用
5. **PyInstaller 输出目录固定为 `dist-python/`**（在 `python/service.spec` 配置 `distpath`），与 electron-builder 的 `dist/` 输出冲突会导致发布产物错误
6. **IPC 入参校验**：主进程对所有入参做类型与路径校验（防目录穿越），Preload 只暴露白名单 API；工作目录路径由主进程持有，`workspace:open` 校验目录存在与可写
7. **原生模块**：better-sqlite3 13.x 自带 in-tarball N-API prebuild（Electron 43 实测加载），配置 `asarUnpack` + `npmRebuild: false` 即可；`postinstall`（`scripts/postinstall.mjs`）在 CI 下 fail-loud，本机无编译工具链时降级警告（2026-08-09 M3 实测：无需 electron-rebuild）
8. **CSP**：渲染进程生产环境 `default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`——`style-src` 放宽因 antd v5 CSS-in-JS 运行时注入 `<style>`（2026-08-09 裁决），`worker-src` 放宽因 Monaco worker 独立 chunk 本地加载（2026-08-09 M5 裁决），`script-src` 保持严格：禁止 remote 加载、禁止 `unsafe-inline` / `unsafe-eval`；开发模式（未打包）例外：`script-src` / `style-src` 放行 `unsafe-inline`（react-refresh 内联脚本与 vite client 内联样式，2026-08-07 裁决）+ `connect-src ws://localhost:*`（HMR）
9. **工作目录即运行时边界**：工作目录的一切（账本/索引/仓库/配置/账户库）切换即整体重建，状态不跨目录串扰；切换后渲染端整页 reload

## 代码规范

- **新增 IPC 能力**的标准链路：`src/shared/ipc.ts` 定义类型 → preload 暴露白名单 → main 注册 handler →（如需后端能力）调 `PythonSvc.request()`
- 状态管理用 Zustand；录入表单用 ProForm；图表用 Ant Charts
- 日志用 electron-log，**禁止记录 PAT / API Key 等敏感信息**（脱敏）
- Python 侧每个 RPC 方法：入参校验 + 异常捕获，错误按 JSON-RPC error 结构返回
- 测试配套：新功能按层补测试（前端 Vitest / 引擎 pytest / 关键链路 Playwright E2E）

## 常见坑

- Python `stdout` 响应后**必须 `flush()`**，否则 Node 端收不到
- 所有 RPC 请求必须带超时（默认 30s），防止悬挂
- 未签名的 Windows 包会被 SmartScreen 拦截；`latest.yml` 必须随产物一起发布，否则 electron-updater 静默失败
- 国内网络安装/打包需镜像变量：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（Electron 二进制）+ `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（NSIS 工具链），两者缺一不可；排障先查 `%TEMP%\eb-dl-*.lock` 与孤儿 node/electron 进程
- beancount 动态导入较多，PyInstaller 用 `--collect-all beancount` 并显式收集 `beanquery`（v3 拆包）
- Monaco worker 必须本地打包：`monaco-editor/editor/editor.worker?worker`（monaco 0.56 exports map 下子路径不带 `esm/vs` 前缀，带前缀会双写报 ERR_MODULE_NOT_FOUND）+ `MonacoEnvironment.getWorker`；CSS 无 exports 映射，经相对路径直入 node_modules；禁 CDN loader（生产 CSP 禁 remote），生产 CSP 需 `worker-src 'self'`
- Monaco 需自定义 beancount 语法高亮（monarch 自研），不要用默认语言模式
- 金额一律十进制字符串（`src/shared/decimal.ts` 精确运算，禁 `parseFloat` / `Number`）：渲染端 InputNumber 用 `stringMode` 直取字符串，主进程余额校验用 `addDecimalStrings`；antd InputNumber 的 `precision` 在 stringMode 下不生效（仅做显示约束，数值校验以正则为准）
- 录入固定两行，两行不能同为 Income/Expenses（借贷配对语义见 `src/shared/account.ts` 的 `isEntryAccountPairValid`）：至少一边为资产/负债/权益账户；账户须大写字母开头、含冒号（`^[A-Z]\S*:\S*$`，M7 终审定稿）
- `accounts:save` 中 `id=0` 的新条目视为新建，主进程按 `nextId()` 分配自增 id；账户 `value`（Beancount 路径）创建后不可编辑；账户库存 `<workspace>/.beanwise/accounts.json`（每工作目录一份）
- 工作目录切换成功后渲染端**整页 reload**（WorkspaceSwitcher `window.location.reload()`）——各域 zustand store 不跨目录残留状态；主进程侧 `activateWorkspace` 先关旧 DB 防泄漏
- antd 锁定 5.x：pro-components 2.8.x 不支持 antd v6（peer 仅 `^4 || ^5`），升级需连带 pro-components 3.x beta，M9 再评估
- VS Code 集成终端会泄漏 `ELECTRON_RUN_AS_NODE=1`，导致 `npm run dev` / E2E 报 "module 'electron' does not provide an export named 'BrowserWindow'"；运行前 `env -u ELECTRON_RUN_AS_NODE`
- DeepSeek 结构化输出：`json_schema` 模式在 deepseek-v4-flash 不稳定（实测 400，ADR 12），一律用 Function Calling（`tool_choice` 强制单 tool `add_entries`）+ 主进程 zod 校验兜底；JSON number 金额允许 coerce 为十进制字符串（宽容分界），日期/账户/货币等语义字段严格拒绝
- AI 测试隔离：`BEANWISE_AI_BASE_URL` 环境变量注入 mock 端点（默认官方端点），E2E/单测走 `src/main/ai-test-server.ts` 进程内 mock（git-test-server 同策略），零网络零计费
- 请求超时用 `AbortSignal.timeout(60s)`；捕获分支按 `err.name === 'AbortError'` 判定（勿依赖 DOMException 实例）
- 报表聚合禁 SQL `SUM()`（TEXT→REAL 丢精度）：SQL 只做行筛选排序，金额累计一律 `addDecimalStrings`；图表 y 值 `Number()` 仅显示层
- electron-updater E2E 注入：`BEANWISE_UPDATE_FEED_URL` → `setFeedURL` + `forceDevUpdateConfig`（dev 无 app-update.yml）；latest.yml 须同时声明 `.exe` 与 `.AppImage` 条目（CI ubuntu 走 AppImageUpdater）

## 文档索引

| 文档                                     | 内容                       |
| ---------------------------------------- | -------------------------- |
| `README.md`                              | 文档结构与维护约定         |
| `technical-proposal/tech-stack.md`       | 技术栈清单（24 项）        |
| `technical-proposal/architecture.md`     | 整体架构、数据流、通信协议 |
| `technical-proposal/implementation-roadmap.md` | 里程碑拆分、共享契约、执行节奏 |
| `technical-proposal/design-decisions.md` | 关键设计决策（ADR）        |
| `technical-proposal/data-consistency.md` | 数据一致性、同步与冲突处理 |
| `technical-proposal/security.md`         | 密钥管理、CSP、进程边界    |
| `technical-proposal/release-pipeline.md` | CI/CD、签名、自动更新      |

## 跑测试时

测试时请使用`F:\BeanWiseData\test`目录跑，这个目录下有账本