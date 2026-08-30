# BeanWise 能力扩展 · 总计划与 Worktree 分批（2026-08-30）

> **For agentic workers:** 本文件是「超 UI 层清单」能力扩展的分批总控。各批次由**独立新会话**执行对应计划 `2026-08-30-cap-{f,h,i,g}-*.md`，REQUIRED SUB-SKILL: superpowers:executing-plans。前一轮 UI 改造（批次 A-E）已全部合并进 `ui-v4`（HEAD `12a201a`），本计划基于该基线。

**Goal:** 落地 UI 方案中留待决策的 6 项能力：明细账账户过滤、报表日/周粒度、三栏式科目余额表、现金流量表、科目期初余额与启停用、账本重命名/归档/删除 + 报表 PDF 导出。

**Architecture:** 沿用 UI 改造的并行安全模型——按「文件所有权互不相交」切分：**波次 1 三批并行 F ∥ H ∥ I，波次 2 收口 G**。共享契约文件（`shared/ipc.ts` / `preload/index.ts` / `shared/api.ts`）由 H（波次 1）与 G（波次 2）顺序持有，F 与 I 不触碰。

**Tech Stack:** 现有栈，零新增依赖。报表聚合在主进程 `report-aggregation.ts`（SQLite 行 → decimal 字符串，禁 SQL SUM），不经 Python。

**Spec:** `ui-optimization-plan.md` 第七节「超 UI 层清单」（本计划逐项兑现）、`CLAUDE.md`。

## Global Constraints（每批隐含遵守）

- 零新增依赖；antd 锁 5.x；金额一律十进制字符串（`addDecimalStrings`/`computeBalancingNumber`，禁 `Number`/`parseFloat`/SQL `SUM`）
- 新增 IPC 按标准链路：`src/shared/ipc.ts` 类型 → `src/preload/index.ts` 白名单 → `src/shared/api.ts` → main handler
- Beancount 文件唯一事实源：期初余额通过**既有 `ledger:add-entry` 通道**落账本（不引入第二写路径，不在配置文件存余额）
- 主进程所有新 handler：入参校验（路径防穿越）+ 异常捕获，错误按 `{ ok: false, message }` 返回
- e2e 依赖文本不得改名：菜单 `录入/明细/报表`、按钮 `写入账本`、报表卡片标题
- worktree 装依赖必须 `npm install --ignore-scripts`（better-sqlite3 prebuild 随 tarball，无需编译）
- 每任务先测后码（纯函数 Vitest TDD），小步提交；VS Code 终端先 `env -u ELECTRON_RUN_AS_NODE`

## 批次总览与波次

| 波次 | 批次 | 分支 | Worktree | 范围 | 前置 | 计划文件 |
|---|---|---|---|---|---|---|
| 1（并行） | F | `ui/f-entry-account-filter` | `.worktrees/f-entry-account-filter` | 明细账账户过滤（超 UI 层 #2 收尾） | 无（基于 ui-v4 HEAD） | `2026-08-30-cap-f-entry-account-filter.md` |
| 1（并行） | H | `ui/h-workspace-mgmt` | `.worktrees/h-workspace-mgmt` | 账本重命名/归档/删除（清单 #3） | 无 | `2026-08-30-cap-h-workspace-mgmt.md` |
| 1（并行） | I | `ui/i-account-config` | `.worktrees/i-account-config` | 科目期初余额 + 启停用（清单 #6） | 无 | `2026-08-30-cap-i-account-config.md` |
| 2 | G | `ui/g-reports-plus` | `.worktrees/g-reports-plus` | 报表域：日/周粒度（#4）+ 三栏余额表（#5）+ 现金流量表（#7）+ PDF 导出（#8） | **F、H、I 全部已合并** | `2026-08-30-cap-g-reports-plus.md` |

> 清单 #1（金额列）、#2 的服务端时间/关键词过滤、#9（窗口）、#10（启动预热主体）已由前轮批次落地，见 `ui-optimization-plan.md` 历史标注。

## 文件所有权（并行不冲突的关键）

- **F 独占**：`src/main/index-builder.ts`（listEntries 查询）、`src/renderer/src/views/ReconcilePage.tsx`、相关 e2e
- **H 独占**：`src/main/workspace-store.ts`、`src/main/ipc-handlers-workspace.ts`、`src/shared/ipc.ts`（workspace 段）、`src/preload/index.ts`、`src/shared/api.ts`、`src/renderer/src/views/SettingsPage.tsx`
- **I 独占**：`src/shared/ipc.ts`（AccountEntry 接口段，与 H 的 IpcChannel 行不同区域，git 自动合并）、`src/renderer/src/stores/ledger.ts`（mergeAccountOptions）、`src/renderer/src/views/AccountsPage.tsx`、`src/main/account-config-store.ts`（若需透传字段）
- **G 独占（波次 2）**：`src/main/report-aggregation.ts`、`src/main/ipc-handlers-report.ts`、`src/main/index.ts`（PDF 通道注册）、`src/shared/ipc.ts`（report 段）、`src/preload/index.ts`、`src/shared/api.ts`、`ReportsView.tsx`、`ReconcilePage.tsx`（Tab①）、`DashboardPage.tsx`、`components/TimeRangeBar.tsx`、`views/reports/*`、`styles/views/reports.less`、`reconcile.less`
- 所有批次**不改**：`App.tsx`、`EntryFormView.tsx`、`main.tsx`、`package.json`

## 批次间接口契约

- F 产出：`ListEntriesParams.account?: string`（精确匹配 posting 行账户；返回行为该账户参与的分录行）——对账页 Tab② 接真数据，占位 Empty 删除
- H 产出：`renameWorkspace(oldPath, newName)` / `archiveWorkspace(path)` / `deleteWorkspace(path)` preload API；workspace-store 增 `removeRecent`/`replaceRecent`；SettingsPage 账本管理卡操作菜单
- I 产出：`AccountEntry.enabled?: boolean`（缺省 true，false 时该配置账户不进录入下拉）；`buildOpeningBalanceEntry(account, number, currency, date): AddEntryParams` 纯函数（Equity:Opening-Balances 配对，走既有 add-entry）
- G 产出（最终）：`ReportGranularity = 'day' | 'week' | 'month' | 'year'`；新通道 `report:trial-balance`（期初/发生/期末三栏）与 `report:cash-flow`（Assets 资金池口径流入/流出/净额）；`report:export-pdf`（printToPDF + 保存对话框）

## 每批次完成标准（DoD）

1. `npm run typecheck` 0 错误；2. `npm run test:unit` 全绿；3. `npm run test:e2e` 全绿（spec 自建临时账本；并行批间 smoke 错峰）；4. 计划 checkbox 全勾；5. **先 `git merge ui-v4` 同步主干**再全量验证，然后主 checkout `git merge --no-ff ui/<batch>` 合回、`git worktree remove .worktrees/<dir>`；6. G 必须等 F/H/I 全部合完。

## 会话提示词

见仓库根目录 `worktree-session-prompts-cap.md`。
