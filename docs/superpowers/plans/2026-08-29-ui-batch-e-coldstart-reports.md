# 批次 E：冷启动体验 + 报表排版 + 收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除冷启动白屏（index.html 内联 Splash + 框架先行 + 图表懒加载），报表页补资产负债表（账户式）与利润表（报告式）排版，全量回归收尾。

**Architecture:** Splash 为 `index.html` 内联**纯 CSS 自淡出**（零脚本、零 JS 移除逻辑，不碰 App.tsx；生产 CSP `style-src 'unsafe-inline'` 已放行）——展示约 1.2s 后由 CSS `animation ... forwards` 自动淡出并 `visibility: hidden`，框架（批次 A）在其下方立即渲染骨架；报表新增两个 Tab，数据全部来自既有 `report:balances` / `report:income-expense`，零 IPC 变更。图表懒加载封装 `LazyLine`/`LazyColumn` 供本批 ReportsView 使用，并作为**批次 D 的消费契约**。

**Tech Stack:** 现有栈，零新依赖。

**Spec:** `ui-optimization-plan.md` 模块 6、9、`docs/superpowers/plans/2026-08-29-ui-optimization-master.md`。

**Worktree:** `.worktrees/e-coldstart-reports`，分支 `ui/e-coldstart-reports`，基于含批次 A 的 `ui-v4`。

**并行说明：** 本批与批次 B、C **同时开工**（波次 2）。文件所有权：本批独占 `index.html` / `ReportsView.tsx` / `views/reports/*` / `components/Lazy*.tsx` / `styles/views/reports.less` / `CLAUDE.md`；**不得改动** `App.tsx`（Splash 为纯 CSS 自淡出，无需 JS 移除逻辑）、`package.json`、四个占位页。合并前先 `git merge ui-v4` 同步主干再跑全量验证。

**前置命令（会话开始时执行；`git worktree add` 不需要也不应该 checkout 主 checkout）：**

```bash
cd /f/raychaoo/BeanWise && git worktree add .worktrees/e-coldstart-reports -b ui/e-coldstart-reports ui-v4 && cd .worktrees/e-coldstart-reports && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。特别强调：`e2e/reports.spec.ts` 依赖的 `净资产趋势` / `收支对比` / `账户余额` 卡片标题与 `起始年`/`结束年` Select **必须保留在报表页默认 Tab**；Splash 禁止任何 `<script>`（CSP `script-src` 严格）；金额展示沿用 `.num` + `formatAmount`。

---

### Task 1: 启动 Splash（纯 CSS 自淡出，不碰 App.tsx）

**Files:**
- Modify: `index.html`（body 内加 `#splash` 节点 + 内联 `<style>`）

**Interfaces:**
- Produces: 约定——splash 节点 `id="splash"`，`position: fixed; inset: 0; pointer-events: none;`（始终不拦截交互，e2e 与用户点击均不受影响），`animation: bw-splash-out 0.4s ease-out 1.2s forwards`（ forwards 保持 `opacity:0; visibility:hidden` 终态）；`@keyframes bw-splash-out` 与 `prefers-reduced-motion` 覆写（直接终态）

- [x] **Step 1: index.html splash** —— `<div id="splash">` 内：居中字标「BeanWise · 豆账」（`color: var(--bw-primary)` 回退 `#1d39c4`）+ 三点呼吸动画（`@keyframes` opacity 循环）；底色 `#f5f7fa`；按 Interfaces 约定实现自淡出；**禁止任何 `<script>`**
- [x] **Step 2: 验证**：`npm run build` 后 `npx electron out/main/index.js` 手动观察冷启动无白屏（或 `npm run dev` 观察 splash 1.2s 后自动淡出，框架骨架在其下已可交互）；typecheck；`npm run test:e2e`（splash `pointer-events:none` 且在 root 外，不挡任何断言）
- [x] **Step 3: Commit** `feat(ui-e): index.html 纯 CSS 自淡出 Splash，冷启动零白屏零 JS`

### Task 2: 图表懒加载（产出 D 批消费的契约）

**Files:**
- Create: `src/renderer/src/components/LazyLine.tsx`、`src/renderer/src/components/LazyColumn.tsx`
- Modify: `src/renderer/src/views/ReportsView.tsx`（仅趋势图两处替换 + `Suspense` fallback `Skeleton.Node`）

**Interfaces:**
- Produces: `LazyLine` / `LazyColumn`（`React.lazy(() => import('@ant-design/charts').then(m => ({ default: m.Line })))` 模式，props 透传，类型收窄为保持 typecheck 通过的最小面）——**批次 D 的 DashboardPage 直接复用**
- 边界：DashboardPage 归批次 D（占位文件），本批不动

- [x] **Step 1: LazyLine/LazyColumn 封装**
- [x] **Step 2: ReportsView 替换** + Suspense
- [x] **Step 3: 验证**：typecheck + `npm run test:e2e -- --grep "报表"`（canvas 可见断言仍过）
- [x] **Step 4: Commit** `perf(ui-e): 图表懒加载 LazyLine/LazyColumn（D 批复用）`

### Task 3: 报表页三表排版

**Files:**
- Modify: `src/renderer/src/views/ReportsView.tsx`（外层加 `Tabs`：`趋势图表`（现有三卡原样，标题与结构不动）/ `资产负债表` / `利润表`）
- Create: `src/renderer/src/views/reports/BalanceSheetTable.tsx`、`src/renderer/src/views/reports/IncomeStatementTable.tsx`
- Create: `src/renderer/src/styles/views/reports.less`

**Interfaces:**
- Consumes: `getBalancesReport`（含起止参数）、`getIncomeExpenseReport`、`formatAmount`、`accountNameMap` 模式

- [x] **Step 1: BalanceSheetTable（账户式）** —— 双栏 `Table` 布局：左栏标题「资产」列 `Assets:*` 逐账户（名称 + `.num` 余额）+ 合计行；右栏「负债与所有者权益」列 `Liabilities:*` + `Equity:*` + 合计行；底部校验行「资产 = 负债 + 权益」——两侧合计用 `addDecimalStrings` 比对，相等显示绿色对勾 Tag，不等红色差额（`computeBalancingNumber` 取反）；期间选择 `TimeRangeBar`（granularity）
- [x] **Step 2: IncomeStatementTable（报告式）** —— 上下一栏：收入账户逐行（`.num`）→ 小计 → 支出账户逐行 → 「净利润」强调行（正负按 `.num-negative` 规则）；月份 `DatePicker picker="month"` 单选传参
- [x] **Step 3: Tabs 接线** —— 默认 Tab `趋势图表` 保持现有 DOM（e2e 依赖）；destroyInactiveTabPane=false 保切换状态
- [x] **Step 4: 验证**：typecheck + unit + `npm run test:e2e -- --grep "报表"` 全绿
- [x] **Step 5: Commit** `feat(ui-e): 报表页资产负债表（账户式）与利润表（报告式）`

### Task 4: 全量回归与收尾

- [x] **Step 1: reduced-motion 审计** —— 全局 grep `animation`：所有 keyframes 均有 `@media (prefers-reduced-motion: reduce)` 覆写
- [x] **Step 2: 清理** —— 删除 `styles.css` 残留（若存在）；`grep -r "styles.css" src/renderer` 为空。占位页（DashboardPage 等）**保留**——批次 D 收口时重写
- [x] **Step 3: 文档** —— `CLAUDE.md` 技术栈 UI 行补一句「样式：Less 分层（styles/）+ antd token 单源（theme/tokens.ts）」与路由说明
- [x] **Step 4:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [x] **Step 5:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree；五批次完成后在 `ui-v4` 上 `git worktree prune` 并可删除各批次分支
