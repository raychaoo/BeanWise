# CLAUDE.md

BeanWise（豆账）— Beancount 复式记账桌面应用（Electron，Windows-only）。
本文件是 AI 编程助手的**入口与护栏**：保留不可违反的约束与易错点，其余细节全部指向本目录下的方案文档（以方案文档为唯一事实源，避免两处维护漂移）。

## 项目概览

- **核心原则**：Beancount 文件是唯一事实源（Single Source of Truth），SQLite 仅为索引缓存，**禁止绕过文件直接写 SQLite**
- **工作目录模型**：应用按「工作目录」组织账本；每个目录独立持有账本 `main.beancount`、索引 `.beanwise/index.db`、git 仓库、同步配置、账户库；**切换即整体重建运行时**（`activateWorkspace` 关旧 db → 重建 db/GitSync/索引 → 渲染端整页 reload），状态不跨目录串扰
- **能力**：账本录入（ProForm 固定两行 + 通用账户库 + DeepSeek AI 辅助，未配 Key 入口隐藏）、校验、图表报表、GitHub 私有仓库同步、electron-updater 自动更新
- **引擎**：Python 3.11 + Beancount v3，PyInstaller 打包为独立二进制随应用分发；Node ↔ Python 走 stdio JSON-RPC 2.0（JSONL 逐行）

## 常用命令

```bash
npm run dev          # Vite dev + Electron
npm run typecheck    # TS 严格模式
npm run test:unit    # Vitest 前端单测
npm run test:e2e     # Playwright Electron E2E（CI 无头需 xvfb-run -a）
npm run build:python # PyInstaller → dist-python/
npm run dist:win     # electron-builder NSIS 安装包
pytest python/tests  # Python 引擎测试
```

## 铁律（违反即 bug，不可放宽）

1. **文件是唯一事实源**：所有写入先落文件、校验通过后再重建 SQLite 索引
2. **密钥隔离**：GitHub PAT / DeepSeek API Key 只在主进程持有（safeStorage 加密），渲染进程不可见；AI 请求走主进程代理
3. **渲染进程不直连后端**：不直连 Python / SQLite / git，一律走 IPC → 主进程；Preload 只暴露白名单 API
4. **Beancount 锁定 v3**：禁 v2 语法 / API，两者差异大不可混用
5. **金额一律十进制字符串**：`src/shared/decimal.ts` 精确运算，禁 `parseFloat` / `Number`；报表禁 SQL `SUM()`（TEXT→REAL 丢精度），SQL 只做行筛选排序，累计走 `addDecimalStrings`；图表 y 值 `Number()` 仅显示层
6. **IPC 入参校验**：主进程做类型与路径校验（防目录穿越）；工作目录路径由主进程持有；新增 IPC 能力标准链路：`src/shared/ipc.ts` 定义类型 → preload 暴露白名单 → main 注册 handler →（需后端能力）调 `PythonSvc.request()`
7. **工作目录即运行时边界**：切换后渲染端整页 reload，各域 zustand store 不跨目录残留

## 易错点（高频踩坑，写代码前看一遍）

- Python `stdout` 响应后**必须 `flush()`**，否则 Node 端收不到
- 所有 RPC 请求必须带超时（默认 30s），防悬挂
- 金额输入用 InputNumber `stringMode` 直取字符串；账户格式须大写字母开头、含冒号（`^[A-Z]\S*:\S*$`）
- 录入固定两行，两行不能同为 Income/Expenses（至少一边为资产/负债/权益，见 `src/shared/account.ts` 的 `isEntryAccountPairValid`）
- 工作目录切换成功后渲染端**整页 reload**（`window.location.reload()`）；主进程 `activateWorkspace` 先关旧 DB 防泄漏
- VS Code 集成终端会泄漏 `ELECTRON_RUN_AS_NODE=1`，导致 `npm run dev` / E2E 报 "module 'electron' does not provide an export named 'BrowserWindow'"；运行前 `env -u ELECTRON_RUN_AS_NODE`
- 国内网络打包需镜像变量：`ELECTRON_MIRROR`（Electron 二进制）+ `ELECTRON_BUILDER_BINARIES_MIRROR`（NSIS 工具链），缺一不可
- 日志用 electron-log，**禁止记录 PAT / API Key 等敏感信息**（脱敏）
- **机器级配置**（electron-store `git-network` / `git-identity`）**跨 E2E 运行持久化**（E2E 不隔离 userData）→ 新增此类配置必须在 `e2e/sync.spec.ts` 的 `resetSync` 里复位，否则随机失败；反过来，凡「按工作目录隔离」的状态（PAT、GitHub 识别缓存）**必须共用 `src/main/utils/workspace-key.ts` 的键函数**，否则换账本目录会串用上一个目录的凭据/身份
- 改 git 提交人身份只影响**之后的提交**（提交对象含 author 行，身份变了 SHA 也变）；任何情况下都**不改写已有历史**
- 测试配套：新功能按层补测试（前端 Vitest / 引擎 pytest / 关键链路 Playwright E2E）

## 跑测试时

测试请使用 `F:\BeanWiseData\test` 目录，该目录下已有账本。

## 方案文档索引（细节在此，勿在 CLAUDE.md 重复）

| 文档 | 内容 | 何时看 |
|---|---|---|
| `technical-proposal/tech-stack.md` | 技术栈清单（框架 / 数据 / UI / 工程化） | 选版本、加依赖 |
| `technical-proposal/architecture.md` | 整体架构、进程边界、数据流、工作目录运行时模型 | 改架构、加 IPC |
| `technical-proposal/design-decisions.md` | 关键设计决策（ADR 1–30：Monaco / isomorphic-git / AI Function Calling / 工作目录 / 账户库 / 报表 / 升级链 / 同步网络与提交人身份…） | 改实现方式、排坑 |
| `technical-proposal/data-consistency.md` | 文件与索引一致性、工作目录隔离、git 同步与冲突处理 | 改写入 / 同步链路 |
| `technical-proposal/security.md` | 密钥管理、CSP、IPC 白名单 | 改安全相关 |
| `technical-proposal/release-pipeline.md` | CI/CD、签名、electron-updater 自动更新 | 改构建发布 |
| `technical-proposal/implementation-roadmap.md` | 里程碑拆分、执行节奏 | 排期 |
| `technical-proposal/excel-import.md` | 通用 Excel 流水导入方案 | 改导入 |

> 新增/修改项目约定时，**只改对应方案文档**，保持本文件为精简护栏；本文件与方案文档冲突时以方案文档为准。
