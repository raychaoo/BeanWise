# 实施路线图（Implementation Roadmap）

> 全项目执行的锚点：**全项目视图 = 本文件 + 6 份方案文档**，各里程碑的执行计划保持「薄」，
> 只写「改哪些文件、边界、验收标准」，具体设计一律引用对应方案文档。

## 执行节奏

```
每次只生成下一个里程碑的计划 → 独立 session 执行 → 绿灯验收 → 进入下一个
```

- 计划不提前囤：实现产生的真实信息（IPC 签名、RPC 行为）会让旧计划过期
- 每个执行 session 的上下文 ≈ 一份薄计划 + 本文件 + 相关方案文档
- 共享契约见下节，所有计划必须对齐，不得各写各的

## 里程碑总览

| # | 里程碑 | 依赖 | 绿灯验收 |
|---|---|---|---|
| M1 | 脚手架 + 构建基线 | — | `dist:win` 产出 NSIS 包可安装启动；CI（test/e2e/build）全绿 |
| M2 | Python 引擎层 | —（与 M1 可并行） | pytest 全绿；Node 侧 RPC 冒烟通过（ping/validate） |
| M3 | IPC 骨架 + SQLite 索引 | M1, M2 | 手工写入一笔交易 → 索引可见；typecheck 绿 |
| M4 | 核心录入链路 | M3 | ProForm 录一笔 → 落文件 → 校验 → 索引更新（端到端） |
| M5 | Monaco 编辑器 | M3 | 打开账本 → beancount 高亮 → 编辑保存 → 校验提示 |
| M6 | Git 同步 | M3 | 推拉到 GitHub 私有仓库；人为冲突 → 三路合并 UI 完成合并 |
| M7 | AI 辅助录入 | M3 | 自然语言 → 交易指令 → 落盘全链路；schema 校验拒绝非法输出 ✅（2026-08-11） |
| M8 | 图表报表 + 发布加固 | M4, M5, M6, M7 | 图表渲染真实数据；升级演练；完整发布演练（tag → Release → 更新，待首版人工） ✅ 完成（2026-08-12） |
| M9 | 工作目录 + 通用账户库 | M4, M6, M7, M8 | 工作目录切换后账本/索引/仓库/配置整体隔离重建；账户库增删改 + 录入两行配对校验生效 ✅（2026-08-22） |
| M10 | 通用 Excel 流水导入 | M4, M9 | 非微信 xlsx/csv 经列映射+账户映射导入；新交易账户检测/处理（策略 C）；去重；多模板持久化 |
| M11 | 同步范围扩展（文件集） | M6, M9, M10 | 换电脑 clone 后账户库与 Excel 模板自动恢复；两机各自新增账户/模板 → 无冲突并集；索引缓存/本机同步配置不进仓库，且无改动时不再产生空提交 ✅（2026-09-17） |
| M12 | 同步网络适应性（本机代理 + 可配置超时） | M6, M11 | 同步设置里可配 HTTP 代理与超时并即时生效（无需重启/切目录）；配了代理后直连与回环行为不变（回环绕过有单测+E2E 钉死）；连接测试能把「代理不可达」「代理未放行」「PAT 不对」分开报 ✅（2026-09-17） |

```plain
M1 ──┬──▶ M3 ──┬──▶ M4 ──┬──▶ M8 ──▶ M9 ──▶ M10 ──▶ M11 ──▶ M12
M2 ──┘        ├──▶ M5    ┘
              ├──▶ M6
              └──▶ M7
```

## 共享契约（所有里程碑必须对齐）

### 目录结构

```
src/main/         # 主进程：ipc 路由、PythonSvc、GitSync、DeepSeek 代理
src/preload/      # contextBridge 白名单
src/renderer/     # React：ProForm 录入 / Monaco / 图表 / Zustand
src/shared/ipc.ts # IPC 类型契约（唯一来源）
python/           # service.py、engine/、tests/、service.spec、requirements*.txt
dist-python/      # PyInstaller 固定输出（与 electron-builder 的 dist/ 分离）
```

### Node ↔ Python（stdio JSON-RPC）

- JSON-RPC 2.0，JSONL 逐行（`\n` 分隔）；方法：`ping` / `parse_file` / `parse_entries` / `validate` / `query` / `render_report` / `shutdown`
- stdout 响应后必须 `flush()`；所有请求带超时（默认 30s）
- 主进程 spawn 管理；异常退出指数退避重启；`before-quit` 优雅关闭
- 开发模式调本机 `python3 service.py --stdio`；打包后经 `extraResources` 从 `process.resourcesPath` 定位

### IPC 契约（本 roadmap 新增约定）

- 类型定义唯一来源：`src/shared/ipc.ts` → preload 白名单 → main handler 注册，禁止旁路
- 通道命名：`{domain}:{action}` 小写 kebab，如 `ledger:validate`、`sync:push`、`ai:parse`
- 主进程对所有入参做类型与路径校验（防目录穿越）
- M3 定稿 ledger 通道 + M6 追加 sync 六通道 + M7 追加 ai 四通道 + M9 追加 accounts/workspace + M12 追加 sync 网络三通道（类型唯一来源 `src/shared/ipc.ts`，跨里程碑复用）：

  | 通道 | params | result 要点 |
  |---|---|---|
  | `ledger:refresh-index` | 无（路径主进程持有） | `{changed, status: ok\|error\|missing, entryCount, errorCount, message?}` |
  | `ledger:status` | 无 | `LedgerStatus \| null`（path/title/operatingCurrency[]/entryCount/errorCount/status/lastError/updatedAt） |
  | `ledger:list-entries` | `{limit? 默认100上限1000, offset? 默认0}` | `{entries: [{id,type,date,flag,payee,narration,account,lineno}], total}` |
  | `ledger:add-entry`（M4） | `{date, flag?('*'\|'!'), payee?, narration?, postings: [{account, number: str(十进制金额), currency}]}`（2~20 行） | `{ok, message?, status, entryCount, errorCount}`（status 为索引重建后状态） |
  | `ledger:list-accounts`（M4） | 无 | `{accounts: string[]}`（postings 表 DISTINCT，上限 500） |
  | `ledger:read-file`（M5） | 无（路径主进程持有） | `{ok, content?, fingerprint?, message?}`（ENOENT → ok:false + message；fingerprint 为打开基线 sha256，保存时比对） |
  | `ledger:save-file`（M5） | `{content, expectedFingerprint}` | `{ok, conflict?, diskContent?, diskFingerprint?, fingerprint?, status?, entryCount?, errorCount?, message?}`（conflict = 外部修改冲突未落盘，disk* 为同一次读取快照） |
  | `sync:get-status`（M6） | 无 | `SyncStatus`（configured/repoUrl?/branch?/lastSyncAt?/lastError?/syncing） |
  | `sync:configure`（M6/M11） | `{repoUrl, pat}` | `{ok, error?, status?, conflict?, conflicts?}`（测试连接 + 首同步场景 A/B/C；conflicts = 逐文件三路快照 `SyncFileConflict[]`，各字段可为 null） |
  | `sync:push`（M6/M11） | 无 | `{ok, conflict?, conflicts?, message?}`（纳管 + 快照 commit → fetch → 逐文件三路合并 → push） |
  | `sync:pull`（M6/M11） | 无 | `{ok, conflict?, conflicts?, message?}`（fetch → 逐文件三路合并 → 落盘 + refreshIndex，只拉不推） |
  | `sync:resolve-conflict`（M6/M11） | `{resolved: [{path, content\|null}]}`（必须覆盖全部冲突文件；账本不可删） | `{ok, status?, entryCount?, errorCount?, message?}`（两阶段校验落盘 → commit → push → refreshIndex） |
  | `sync:clear`（M6） | 无 | `{ok}` |
  | `sync:get-network`（M12） | 无 | `GitNetworkConfig`（proxyUrl / timeoutSec；**机器级**，不随工作目录） |
  | `sync:save-network`（M12） | `GitNetworkConfig` | `{ok, error?, network?}`（非法代理地址 → ok:false 回显，不 reject） |
  | `sync:test-connection`（M12） | `{repoUrl?}`（缺省用已保存配置） | `{ok, message}`（真实 git 握手 `listServerRefs`；诊断区分代理不可达 / 未放行 / 认证失败） |
  | `ai:get-status`（M7） | 无 | `AiStatus`（configured/model；**不含 Key**——渲染端永不接触密钥） |
  | `ai:save-config`（M7） | `{apiKey}` | `{ok, error?}`（Key 经 safeStorage 存主进程，渲染端不落 state） |
  | `ai:clear-config`（M7） | 无 | `{ok}` |
  | `ai:parse`（M7） | `{text}`（≤2000 字符） | `{ok, drafts?: AddEntryParams[], message?, error?}`（草稿回填 ProForm，写路径唯一） |
  | `report:net-worth`（M8） | `{granularity: 'month'\|'year'}` | `{series: [{period, assets, liabilities, netWorth}], currency, message?}`（期间累计，仅运营货币；金额 decimal 字符串） |
  | `report:balances`（M8） | 无 | `{accounts: [{name, balances: [{currency, number}], children?}], message?}`（账户树 + 子树 rollup，多币种分行） |
  | `report:income-expense`（M8） | `{granularity, year?}` | `{series: [{period, income, expense}], currency, message?}`（income/expense 正显示；月视图 12 个月补满，year 缺省最近年份） |
  | `update:check`（M8） | 无 | `{ok, message?}`（触发 updater 状态机） |
  | `update:status`（M8） | 无 | `UpdateState`（idle/checking/available/downloading/downloaded/error + currentVersion/progress/error） |
  | `update:install`（M8） | 无 | `{ok, message?}`（quitAndInstall）；事件 `update:status-changed` main→renderer |
  | `accounts:get`（M9） | 无 | `{ok, accounts?: AccountEntry[]}`（AccountEntry：id/name/value/description?） |
  | `accounts:save`（M9） | `{accounts}` | `{ok, accounts?, message?}`（id=0 新建按 nextId 自增；value 不可改；上限 500） |
  | `workspace:get-status`（M9） | 无 | `WorkspaceStatus`（current 绝对路径 / ledgerFile=main.beancount；未选择 → current:null） |
  | `workspace:choose`（M9） | 无 | `{ok, canceled?, path?, message?}`（dialog 返回取消 → canceled:true） |
  | `workspace:open`（M9） | `{path}` | `{ok, status?, message?}`（校验目录 + 初始化 git + 接管/创建账本文件 → 整页 reload） |
  | `excel:choose`（M10） | 无 | `{ok, canceled?, path?, message?}`（.xlsx / .csv 文件选择） |
  | `excel:parse`（M10） | `{path, template?}` | `{ok, sheets?, headerRow?, columns, suggestedMapping?, sampleRows?, message?}`（文件级识别，不落账） |
  | `excel:preview`（M10） | `{path, template}` | `{ok, rows, newAccounts?: [{key, count, amount, resolution}], totals?, message?}`（应用列映射+方向+账户映射 + 新交易账户检测） |
  | `excel:import`（M10） | `{path, template, rowIds}` | `{ok, imported, skipped, status, entryCount, errorCount, message?}`（写锁内原子落盘 + 索引重建 + 账户库同步） |
  | `excel:get-templates`（M10） | 无 | `{ok, templates: ExcelImportTemplate[]}` |
  | `excel:save-template`（M10） | `{template}` | `{ok, template?, message?}`（id 空新建 / 覆盖） |
  | `excel:delete-template`（M10） | `{id}` | `{ok, message?}` |

### 数据流铁律

- Beancount 文件是唯一事实源：**先落文件 → 校验 → 重建 SQLite 索引**；禁止绕过文件写 SQLite
- 文件变更 → 增量解析 → 重建索引；增量失败回退全量并记日志

### 安全边界

- GitHub PAT / DeepSeek Key 只存主进程（safeStorage 加密），渲染进程不可见
- 渲染进程不直连 Python / SQLite / git；AI 请求走主进程代理
- CSP：生产 `default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`（`style-src` 放宽因 antd CSS-in-JS；`worker-src` 因 Monaco worker 独立 chunk）；禁 remote 加载、`script-src` 禁 `unsafe-inline` / `unsafe-eval`；开发模式例外：`script-src` / `style-src` 放行 `unsafe-inline`（react-refresh / vite client 内联样式）+ `connect-src ws://localhost:*`（HMR），完整口径见 CLAUDE.md 约束 #8
- electron-log 脱敏，禁止记录 PAT / API Key

### 平台与版本（2026-08 定稿：仅 Windows）

- 平台：Windows-only（NSIS）；`latest.yml` 随产物发布；无签名发布（M8 裁决：放弃签名，`CSC_IDENTITY_AUTO_DISCOVERY=false`，SmartScreen 风险接受，见 release-pipeline.md）
- 版本：Electron 最新稳定 · Node 22（CI）· Python 3.11 · Beancount v3（锁定，禁止 v2）
- 原生模块：better-sqlite3 13.x 自带 in-tarball N-API prebuild（Electron 43 实测），`asarUnpack` + `npmRebuild: false` + CI fail-loud postinstall（M3 定稿，见 CLAUDE.md 约束 #7）
- PyInstaller：`--onefile` → `dist-python/`（spec 配 distpath）；`--collect-all beancount` + 显式收集 `beanquery`
- CI：test/e2e 跑 ubuntu（xvfb，测试基础设施），build/release 跑 windows

## 里程碑边界说明

| # | 做什么 | 不做（留给后续/明确排除） |
|---|---|---|
| M1 | Vite+Electron+TS 骨架、npm scripts、electron-builder 出包、CI 基线 | 业务代码；签名（留 M8） |
| M2 | Python service + JSON-RPC + 7 个方法 + pytest + PyInstaller | 增量解析策略（M3）；AI 解析（走主进程代理，不经 Python） |
| M3 | 3 层 IPC 骨架、Drizzle 表结构、增量解析→索引重建、PythonSvc 生命周期 | 业务 UI；录入表单 |
| M4 | ProForm 录入表单、校验错误展示、落文件→索引链路（金额一律十进制字符串 + 末行自动平衡；追加写 + 索引 error 时 truncate 回滚；首文件自动补账户 open 行——写失败策略见 data-consistency.md） | 编辑已有交易（M5）；AI 录入（M7） |
| M5 | Monaco 编辑器 + 自研 monarch beancount 语法高亮、整文件覆盖保存（tmp 校验 + rename 原子替换，校验失败不落盘）、外部修改冲突检测（sha256 指纹比对 + DiffEditor 决策）、DiffEditor 基础；生产 CSP 补 `worker-src 'self'`（Monaco worker 独立 chunk） | 三路合并 UI（M6） |
| M6 | isomorphic-git 推拉（账本目录即 git 工作区，只追踪账本文件；分支固定 main/remote 固定 origin）、PAT 录入（safeStorage 加密，仅主进程持有）、保存后自动 push + 手动 pull、diff3 自动合并（干净合并 → 双亲合并提交落盘；冲突才弹三路 UI：base/ours/theirs + merged 编辑）、force push 仅场景 C 接管（unrelated histories）、sync 域 syncing 互斥（push/pull/configure/resolve 任一进行中其余拒绝） | 自动定时同步（可后置，sync:push/pull 即定时器执行体）；自动 push 仅挂编辑器保存（saveEditorFile），add-entry / AI 录入不触发（M7 交接）；多账本文件追踪（目前单文件） |
| M7 | DeepSeek 代理、function calling tool schema、主进程 schema 校验 → 落地：ai 域四通道 + DeepSeekProxy（tool_choice 强制）+ zod 4 单源校验 + AiEntryPanel（生成草稿→填入表单，写路径唯一）+ AI 设置 Modal（Key safeStorage）；单次生成 + 草稿确认，多笔数组（≤10），账户列表注入 system prompt | 提示词工程打磨 |
| M8 | Ant Charts 报表、electron-updater 升级链、发布加固（无签名口径）、发布演练 | — |
| M9 | 工作目录模型（workspace 域四通道 + WorkspaceGate/WorkspaceSwitcher + electron-store current/recents；每目录独立 db/git/同步配置，切换整页 reload）、通用账户库（accounts 域两通道 + `.beanwise/accounts.json` + 录入下拉 = 账本账户 ∪ 账户库）、双行配对校验（两行不能同为 Income/Expenses）、报表余额树收入正显示、AI 未配置隐藏入口 | 多账本文件追踪（仍单文件 main.beancount）；账户 value 编辑（创建后不可改） |
| M10 | 通用 Excel 流水导入（excel 域七通道 + 列映射/方向判定/账户映射两层映射 + 新交易账户检测与处理策略 C + `beanwise-import` 去重标记 + 多模板持久化 `.beanwise/excel-import-templates.json`；复用 open 校正/原子落盘/索引重建/账户库同步） | 关键字自动归类（对方/商品→科目）；微信导入重构为通用模板；导入回滚；多币种自动折算 |
| M11 | 同步范围扩展（2026-09-17）：追踪文件集 = 账本 + 账户库 + Excel 模板 + 受托管 `.gitignore`（`src/shared/sync-files.ts` 单一事实源）；`index.db`/`sync-config.json` 走托管忽略块；GitSync 多文件化（`addTrackedFiles`/`ensureGitignore`/`blobTextAt`，add 带 `force` 防用户忽略规则吞数据）；脏判定改逐文件比对 HEAD blob（修掉「每次 push 产生空提交」）；`core/merge-engine.ts` 纯函数三态合并 + JSON 语义键结构化并集（收敛性属性测试）+ 两阶段落盘；冲突载荷改逐文件三态，ConflictView 按文件分 tab（JSON 只做二选一）；账户库/模板保存后自动 push + `generation` 驱动视图重载；场景 B 判据收窄为「任一内容文件非空」（不再 clone 覆盖本地账户库） | 三方合并的 base 快照 UI（当前只对比 ours/theirs）；`.gitignore` 冲突不做专项 UI（走文本三路合并）；账户库跨机 id 稳定（当前可重排，仅影响界面排序） |
| M12 | 同步网络适应性（2026-09-17）：`core/git-network.ts` 包 http 插件注入代理 agent（isomorphic-git 顶层命令不收 `agent`，只有插件层透传给 simple-get）；机器级 electron-store `git-network`（代理 + 超时）；同步设置「本机网络」区 + `sync:get/save-network`、`sync:test-connection` 三通道；超时 1~600s 可配（默认 30），`network()` 每次调用求值即时生效；目标回环一律直连 | SOCKS5；系统代理/环境变量自动探测（只手动填）；带认证的代理（需把密码放 safeStorage）；超时后中断底层 socket（isomorphic-git 1.41.3 不支持 signal，仍是 `Promise.race`）；代理只作用于 git 同步（updater 走 Electron 网络栈、AI 走主进程 fetch，都不动） |

## 排序理由与风险

- **M1/M2 并行**：互不依赖，可两个 session 同时推进；M2 是全项目最长尾风险（beancount 动态导入打包、v3 拆包），尽早暴露
- **M3 是枢纽**：之后 M4-M7 全部只依赖 M3 的接口，M3 的契约质量决定后面四个里程碑的返工量
- **M4 先于 M5/M6/M7**：核心价值链路（录入→落盘→索引）最先闭环，验证「唯一事实源」原则可行
- **M6 冲突处理是 UX 高风险项**（自研三路合并 UI），留足迭代空间
- 最大风险：M2（PyInstaller 收集）、M6（isomorphic-git 私有仓库 + 冲突合并）、M7（deepseek-v4-flash 的 function calling 稳定性，见 ADR 12）
