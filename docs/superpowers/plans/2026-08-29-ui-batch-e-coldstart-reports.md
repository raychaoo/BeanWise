# 批次 E：冷启动体验 + 报表排版 + 收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除冷启动白屏（index.html 内联 Splash + 框架先行 + 图表懒加载），报表页补资产负债表（账户式）与利润表（报告式）排版，全量回归收尾。

**Architecture:** Splash 为 `index.html` 内联纯 CSS（零脚本，生产 CSP `style-src 'unsafe-inline'` 已放行），React 挂载后移除；报表新增两个 Tab，数据全部来自既有 `report:balances` / `report:income-expense`，零 IPC 变更。

**Tech Stack:** 现有栈，零新依赖。

**Spec:** `ui-optimization-plan.md` 模块 6、9、`docs/superpowers/plans/2026-08-29-ui-optimization-master.md`。

**Worktree:** `.worktrees/e-coldstart-reports`，分支 `ui/e-coldstart-reports`，基于含批次 A-D 的 `ui-v4`。

**前置命令（会话开始时执行）：**

```bash
cd /f/raychaoo/BeanWise && git checkout ui-v4 && git worktree add .worktrees/e-coldstart-reports -b ui/e-coldstart-reports ui-v4 && cd .worktrees/e-coldstart-reports && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。特别强调：`e2e/reports.spec.ts` 依赖的 `净资产趋势` / `收支对比` / `账户余额` 卡片标题与 `起始年`/`结束年` Select **必须保留在报表页默认 Tab**；Splash 禁止任何 `<script>`（CSP `script-src` 严格）；金额展示沿用 `.num` + `formatAmount`。

---

### Task 1: 启动 Splash

**Files:**
- Modify: `index.html`（body 内加 `#splash` 节点 + 内联 `<style>`）
- Modify: `src/renderer/src/App.tsx`（mount 后移除 splash 的 useEffect）

**Interfaces:**
- Produces: 约定——splash 节点 `id="splash"`，App 首次渲染 `useEffect` 中 `document.getElementById('splash')` 加 `class="bw-splash-hide"`（CSS opacity 200ms 过渡），`transitionend`/300ms 后 `remove()`

- [ ] **Step 1: index.html splash** —— `<div id="splash">` 内：居中字标「BeanWise · 豆账」（`color: var(--bw-primary)` 回退 `#1d39c4`）+ 三点呼吸动画（`@keyframes` opacity 循环）；底色 `#f5f7fa`；`bw-splash-hide { opacity: 0; transition: opacity .2s ease-out; }` + `@media (prefers-reduced-motion: reduce)` 关闭动画
- [ ] **Step 2: App 移除逻辑**（首次 useEffect，幂等：节点不存在则跳过）
- [ ] **Step 3: 验证**：`npm run build` 后 `npx electron out/main/index.js` 手动观察冷启动无白屏（或 `npm run dev` 观察 splash 闪现与淡出）；typecheck；`npm run test:e2e`（smoke 首屏断言不受影响——splash 在 root 外不挡 e2e 元素）
- [ ] **Step 4: Commit** `feat(ui-e): index.html 内联 Splash，冷启动零白屏`

### Task 2: 图表懒加载

**Files:**
- Modify: `src/renderer/src/views/DashboardPage.tsx`、`src/renderer/src/views/ReportsView.tsx`（`React.lazy(() => import('@ant-design/charts').then(m => ({ default: m.Line })))` 模式抽组件 `components/LazyLine.tsx` / `LazyColumn.tsx`）+ `Suspense fallback={<Skeleton.Node active style={{height:280}}/>}`

- [ ] **Step 1: LazyLine/LazyColumn 封装**（props 透传图表 props，类型 `ComponentProps<typeof Line>` 收窄为 `Record<string, unknown>` + key 字段或直接 any 化注释说明——保持 typecheck 通过的最小类型面）
- [ ] **Step 2: 两页替换** + Suspense
- [ ] **Step 3: 验证**：typecheck + `npm run test:e2e -- --grep "报表"`（canvas 可见断言仍过）
- [ ] **Step 4: Commit** `perf(ui-e): 图表组件懒加载，首屏不背 Ant Charts`

### Task 3: 报表页三表排版

**Files:**
- Modify: `src/renderer/src/views/ReportsView.tsx`（外层加 `Tabs`：`趋势图表`（现有三卡原样，标题与结构不动）/ `资产负债表` / `利润表`）
- Create: `src/renderer/src/views/reports/BalanceSheetTable.tsx`、`src/renderer/src/views/reports/IncomeStatementTable.tsx`
- Create: `src/renderer/src/styles/views/reports.less`

**Interfaces:**
- Consumes: `getBalancesReport`（含起止参数）、`getIncomeExpenseReport`、`formatAmount`、`accountNameMap` 模式

- [ ] **Step 1: BalanceSheetTable（账户式）** —— 双栏 `Table` 布局：左栏标题「资产」列 `Assets:*` 逐账户（名称 + `.num` 余额）+ 合计行；右栏「负债与所有者权益」列 `Liabilities:*` + `Equity:*` + 合计行；底部校验行「资产 = 负债 + 权益」——两侧合计用 `addDecimalStrings` 比对，相等显示绿色对勾 Tag，不等红色差额（`computeBalancingNumber` 取反）；期间选择 `TimeRangeBar`（granularity）
- [ ] **Step 2: IncomeStatementTable（报告式）** —— 上下一栏：收入账户逐行（`.num`）→ 小计 → 支出账户逐行 → 「净利润」强调行（正负按 `.num-negative` 规则）；月份 `DatePicker picker="month"` 单选传参
- [ ] **Step 3: Tabs 接线** —— 默认 Tab `趋势图表` 保持现有 DOM（e2e 依赖）；destroyInactiveTabPane=false 保切换状态
- [ ] **Step 4: 验证**：typecheck + unit + `npm run test:e2e -- --grep "报表"` 全绿
- [ ] **Step 5: Commit** `feat(ui-e): 报表页资产负债表（账户式）与利润表（报告式）`

### Task 4: 全量回归与收尾

- [ ] **Step 1: reduced-motion 审计** —— 全局 grep `animation`：所有 keyframes 均有 `@media (prefers-reduced-motion: reduce)` 覆写
- [ ] **Step 2: 清理** —— 删除不再被引用的占位文件（DashboardPlaceholder 等）与 `styles.css` 残留；`grep -r "styles.css" src/renderer` 为空
- [ ] **Step 3: 文档** —— `CLAUDE.md` 技术栈 UI 行补一句「样式：Less 分层（styles/）+ antd token 单源（theme/tokens.ts）」与路由说明
- [ ] **Step 4:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [ ] **Step 5:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree；五批次完成后在 `ui-v4` 上 `git worktree prune` 并可删除各批次分支
