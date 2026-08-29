# BeanWise UI 优化 · 总计划与 Worktree 分批

> **For agentic workers:** 本文件是分批总控文档。每个批次（worktree）由**独立新会话**执行对应批次计划 `2026-08-29-ui-batch-{a..e}-*.md`，REQUIRED SUB-SKILL: superpowers:executing-plans。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 按 `ui-optimization-plan.md`（下称「方案」）完成 BeanWise UI 全面改造，5 个 worktree 批次按「A 先行 → B/C/E 三批并行 → D 收口」落地。

**Architecture:** 批次 A 独先行打地基（路由化 + ProLayout + Token/Less 体系 + **全部页面占位路由**），合并后 **B、C、E 三批可同时在各自 worktree 开工**（文件所有权互不相交，见下表），每批完成即合回；三批全部合并后 **D 收口**（重写四个占位页为真实页面 + 承接跨批迁移）。

**Tech Stack:** Electron + electron-vite + React 19 + antd 5.29 + ProComponents 2.8.10 + Zustand 5 + Less（新增 devDep）+ react-router-dom（唯一新增 runtime 依赖，HashRouter）。

**Spec:** `ui-optimization-plan.md`（设计决策与代码骨架）、`ui-plan.md`（需求书与硬性红线）、`CLAUDE.md`（项目约束）。执行者三份都要读。

## Global Constraints（每个批次隐含遵守）

- 仅新增 runtime 依赖 `react-router-dom`（HashRouter）；`less` 仅为 devDependency（Vite 内置支持，零配置）
- 路由切换动画纯 CSS（180ms fade+translateY），`prefers-reduced-motion` 下禁用；仅主内容区参与动画
- 主内容区唯一滚动容器；Header/Sider 固定不随滚动
- 金额一律十进制字符串：录入 `stringMode` 不动；任何前端聚合用 `addDecimalStrings`（`src/shared/decimal.ts`），禁 `Number`/`parseFloat`/SQL SUM
- 写路径唯一：录入仍走 ProForm → `ledger:add-entry`；Excel/AI 面板仅换容器（Drawer），逻辑零改动
- 不修改已有 API / DB 结构 / 业务逻辑 / 不删功能；新增 IPC 按标准链路：`src/shared/ipc.ts` 类型 → preload 白名单 → main handler
- CSP 禁 remote 字体与 CDN；生产 `style-src 'unsafe-inline'` 已放行（index.html 内联 Splash 样式可用）
- antd 锁 5.x（禁 v6）；`@ant-design/v5-patch-for-react-19` 必须是 main.tsx 第一行 import
- E2E 依赖的菜单文本 `录入` / `明细` / `报表` **不得改名**（`e2e/ledger-index.spec.ts`、`e2e/reports.spec.ts` 依赖）
- 每任务先测后码（纯函数 Vitest TDD；视图层 typecheck + e2e 回归），小步提交
- 测试账本目录：`F:\BeanWiseData\test`；VS Code 集成终端先 `env -u ELECTRON_RUN_AS_NODE` 再跑 dev/E2E
- **worktree 内装依赖必须 `npm install --ignore-scripts`**：better-sqlite3 的 node-gyp install 脚本在本机无编译工具链时会失败，但其 N-API prebuild（prebuilds/win32-x64.node）随 tarball 自带、Electron 43 直接加载（CLAUDE.md 约束 7），跳过脚本无损

## 批次总览与合并顺序

| 波次 | 批次 | 分支 | Worktree 路径 | 范围 | 前置 | 计划文件 |
|---|---|---|---|---|---|---|
| 1 | A | `ui/a-foundation` | `.worktrees/a-foundation` | 路由化 + ProLayout + Token/Less 地基 + **全部占位路由/菜单** + 窗口尺寸 | 无（基于 ui-v4 HEAD，worktree 已建好） | `2026-08-29-ui-batch-a-foundation.md` |
| 2（并行） | B | `ui/b-transaction` | `.worktrees/b-transaction` | 交易域：录入双栏 + Excel/AI 抽屉化 + 流水筛选 | A 已合并 | `2026-08-29-ui-batch-b-transaction.md` |
| 2（并行） | C | `ui/c-workspace` | `.worktrees/c-workspace` | 账本切换：recents 全链路 + Dropdown + Ctrl+K | A 已合并 | `2026-08-29-ui-batch-c-workspace.md` |
| 2（并行） | E | `ui/e-coldstart-reports` | `.worktrees/e-coldstart-reports` | 纯 CSS Splash + 报表三表排版 + 图表懒加载 | A 已合并 | `2026-08-29-ui-batch-e-coldstart-reports.md` |
| 3 | D | `ui/d-new-pages` | `.worktrees/d-new-pages` | 收口：总览/对账/账户/设置四页 + 跨批迁移 | **A、B、C、E 全部已合并** | `2026-08-29-ui-batch-d-pages.md` |

**并行规则（波次 2）**
- B、C、E 三批**文件所有权互不相交**，同时开工不会产生合并冲突：
  - B 独占：`EntryFormView.tsx`、`views/entry/*`、`EntriesView.tsx`、`styles/views/entry*.less`、`utils/format.ts`、`utils/accountGroup.ts`
  - C 独占：`LedgerSwitcher.tsx`、`QuickSwitchModal.tsx`、`utils/path.ts`、`preload/index.ts`、`shared/api.ts`、`src/main/ipc-handlers-workspace.ts`
  - E 独占：`index.html`、`ReportsView.tsx`、`views/reports/*`、`components/Lazy*.tsx`、`styles/views/reports.less`、`CLAUDE.md`
  - 三批都**不改** `App.tsx` / `main.tsx` / `package.json`（归 A 独占；A 已合并，后续无人再动）
- 合并顺序不限（建议 B → C → E）；每批合并前必须 `git merge ui-v4`（或 rebase）到最新 `ui-v4` 再跑全量验证
- **E2E 错峰**：各 spec 用独立临时账本（`createFixtureCopy()`），并行安全；唯 `smoke.spec.ts` 读全局 electron-store 的默认工作目录，三个会话**不要同时**跑全量 e2e（错开几分钟即可）；单测/typecheck 可随时并行
- 各批 worktree 的 `npm install --ignore-scripts` 互不影响（各自独立 node_modules）

## 批次间接口契约（后续批次依赖的产物）

批次 A 产出（B/C/D/E 全部消费）：
- `src/renderer/src/theme/tokens.ts`：`export const BW_COLORS = { primary: '#1d39c4', inflow: '#08979c', outflow: '#d46b08', negative: '#cf1322', bgLayout: '#f5f7fa', textBase: '#0f172a' }` 与 `export const THEME_TOKENS: ThemeConfig`（antd token 对象）
- Less 脚手架：`src/renderer/src/styles/tokens.less`（`--bw-*` CSS 变量 + `@bw-*` less 变量）、`base.less`（`.num` 金额类）、`layout.less`（`.page-scroll` / `.page-enter` / reduced-motion）
- 路由表（**全部一次建齐**，D 只重写占位文件内容、不改 App.tsx）：`/`→`views/DashboardPage.tsx`（占位）`/entry` `/entries` `/reports` `/editor` `/merge` `/accounts`→`views/AccountsPage.tsx`（占位）`/reconcile`→`views/ReconcilePage.tsx`（占位）`/settings`→`views/SettingsPage.tsx`（占位），`*` → `/`；菜单含 `对账`/`账户` 项
- `src/renderer/src/stores/entry-form.ts`：`useEntryFormStore`（`{ dirty: boolean; setDirty(v: boolean): void }`）——B 接线写入、C 只读消费
- `App.tsx` 结构：HashRouter + ProLayout + `.page-scroll` 滚动容器 + scroll 复位 + `workspaceError` → `Result` 兜底；菜单标签 `录入/明细/报表` 保持不变
- `src/renderer/src/views/LedgerSwitcher.tsx`：基础版（当前账本名 + 浏览其他目录），批次 C 增强
- 窗口 1440×900 / min 1280×800（`src/main/index.ts`）

批次 B 产出：`formatAmount`（`utils/format.ts`）、`groupAccountOptions`（`utils/accountGroup.ts`）、`balanceHintState`、EntryFormView 的 dirty 接线（写 `useEntryFormStore`）。
批次 C 产出（D 消费）：`getWorkspaceRecents()` preload API；`basenamePath`（`utils/path.ts`）；`switchWorkspace`（LedgerSwitcher 导出，D 设置页复用）。
批次 E 产出（D 消费）：`components/LazyLine.tsx` / `LazyColumn.tsx`（D 的 DashboardPage 图表直接复用）；纯 CSS 自淡出 Splash（不依赖任何 JS 移除逻辑）。

批次 D 消费上述全部产物，且**不改 App.tsx**——只重写 A 预置的四个占位页文件内容。

## 每批次完成标准（DoD）

1. `npm run typecheck` 0 错误
2. `npm run test:unit` 全绿
3. `npm run test:e2e` 全绿（spec 自建临时账本，无需 F:\BeanWiseData\test；smoke 依赖全局默认工作目录）
4. 该批次计划文件所有 checkbox 勾选
5. **先 `git merge ui-v4` 同步最新主干**（并行批次间互相吸收对方已合并内容），再全量验证，然后合回：在主 checkout 执行 `git merge --no-ff ui/<batch>`，`git worktree remove .worktrees/<dir>`
6. 波次 2 的三批**各自独立合并、互不等待**；波次 3（D）必须等三批全部合完再开工

## 各批次新会话提示词

见仓库根目录 `worktree-session-prompts.md`（与本文件同步维护，内容一致）。
