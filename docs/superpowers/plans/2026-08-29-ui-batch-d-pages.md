# 批次 D：新页面（总览 Dashboard + 对账 + 账户 + 设置）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐四个缺失页面：总览指标卡与同比趋势（零 IPC 变更）、对账（余额表）、账户（科目管理页）、设置（聚合页）。

**Architecture:** 所有新页面消费既有 IPC（`report:balances` / `report:income-expense` / `report:net-worth` / `report:years` / accounts 域）；新增 `stores/dashboard.ts` 负责指标聚合（decimal 字符串累加）与去年序列查询；`AccountSettingsModal` 内容整体升级为页面；设置页承接批次 B 迁入的区块并纳入 recents 管理。

**Tech Stack:** 现有栈，零新依赖；图表用 @ant-design/charts（已有）。

**Spec:** `ui-optimization-plan.md` 模块 2、4、5 及「设置页」节、`docs/superpowers/plans/2026-08-29-ui-optimization-master.md`。

**Worktree:** `.worktrees/d-new-pages`，分支 `ui/d-new-pages`，基于含 **批次 A、B、C、E 全部已合并** 的 `ui-v4`（波次 3 收口批，必须最后开工）。

**收口说明：** 路由与菜单已由批次 A 全部建齐（`/` `/reconcile` `/accounts` `/settings` 指向四个占位文件）——本批**重写这四个占位文件的内容，不改 App.tsx**。同时执行跨批迁移：把批次 B 保留在 EntriesView 的「索引状态卡 + 清空账本」迁入设置页（此时 B 已合并，顺序执行无冲突）；DashboardPage 图表复用批次 E 的 `LazyLine`/`LazyColumn`；账本管理复用批次 C 的 `getWorkspaceRecents` 与 `switchWorkspace`。

**前置命令（会话开始时执行；`git worktree add` 不需要也不应该 checkout 主 checkout）：**

```bash
cd /f/raychaoo/BeanWise && git worktree add .worktrees/d-new-pages -b ui/d-new-pages ui-v4 && cd .worktrees/d-new-pages && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。特别强调：**指标聚合禁 Number/parseFloat** —— 余额累加用 `addDecimalStrings`（`src/shared/decimal.ts`）；图表 y 值 `Number()` 仅显示层；`reports.spec.ts` 依赖的 `/reports` 卡片标题（净资产趋势/收支对比/账户余额）与起始年/结束年 Select **不得改动**（本批不动 ReportsView）。

---

### Task 1: 时间范围组件

**Files:**
- Create: `src/renderer/src/components/TimeRangeBar.tsx`
- Create: `src/renderer/src/hooks/useTimeRange.ts`
- Test: `src/renderer/src/hooks/useTimeRange.test.ts`

**Interfaces:**
- Produces: `useTimeRange(): { preset: 'today'|'week'|'7d'|'month'|'custom'|'all'; range: [dayjs.Dayjs, dayjs.Dayjs] | null; setPreset(p): void; setCustomRange(r): void }`（presets 用 dayjs 计算：today=当日、week=本周一起、7d=近7天、month=本月一日起）；`TimeRangeBar` props `{ value, onChange, showPresets?: boolean, showGranularity?: boolean }`（granularity 为 Segmented 月/年，供报表口径）

- [x] **Step 1: 失败测试**（preset→range 边界：'7d' 的 end 为今天、start 为 6 天前零点；'week' start 为本周一）
- [x] **Step 2: 跑失败** → FAIL
- [x] **Step 3: 实现**；**Step 4: 跑通过**
- [x] **Step 5: Commit** `feat(ui-d): 统一时间范围 hook 与筛选条`

### Task 2: Dashboard 聚合 store

**Files:**
- Create: `src/renderer/src/stores/dashboard.ts`
- Test: `src/renderer/src/stores/dashboard.test.ts`

**Interfaces:**
- Consumes: `window.beanwise.getBalancesReport / getIncomeExpenseReport / getNetWorthReport`（既有）；`addDecimalStrings`（shared/decimal）
- Produces: 纯函数 `sumBalancesByRoot(balances: AccountBalance[]): { assets: string; liabilities: string; equity: string }`（按账户首段归类，多币种以运营货币为主、其余币种单独列出）；`extractMonthPoints(points: IncomeExpensePoint[], month: string): { income: string; expense: string } | null`；zustand store `useDashboardStore`（`{ loading, error, metrics, prevYearSeries, reloadAll(range) }`）

- [x] **Step 1: 失败测试**（`sumBalancesByRoot`：混排 Assets/Liabilities/嵌套子账户 → 三值正确累加，如 `'1200.50' + '-300'`；`extractMonthPoints`：命中/未命中当月）
- [x] **Step 2: 跑失败** `npx vitest run src/renderer/src/stores/dashboard.test.ts` → FAIL
- [x] **Step 3: 实现**（累加走 `addDecimalStrings`，异常输入 `'0'` 兜底；store 的 `reloadAll` 并行拉 balances + 当月 income-expense + 去年同段 net-worth）
- [x] **Step 4: 跑通过** → PASS；typecheck
- [x] **Step 5: Commit** `feat(ui-d): Dashboard 聚合 store（decimal 精确累加 + 去年序列）`

### Task 3: 总览页 DashboardPage（重写占位文件）

**Files:**
- Modify: `src/renderer/src/views/DashboardPage.tsx`（批次 A 占位 → 完整页面；路由已指向此文件，App.tsx 零改动）
- Create: `src/renderer/src/styles/views/dashboard.less`

**Interfaces:**
- Consumes: Task 1/2 产物、批次 A 的 `.num` 与 `BW_COLORS`、批次 E 的 `LazyLine`（图表懒加载）

- [x] **Step 1: 指标卡行** —— 4 × `Card`+`Statistic`（总资产/总负债/净资产/本月收支）：值 `formatAmount` 千分位；净资产卡片值颜色遵循 `BW_COLORS`（正文本色、负 `#cf1322`）；本月收支 `suffix` 放 ↑(青)/↓(橙) 图标 + 金额；每卡 `loading` 用 `Skeleton.active`（高度对齐 Statistic，防跳变）
- [x] **Step 2: 趋势卡** —— `Card title="净资产趋势"` 内 `LazyLine`：本期序列实线 + 去年同期虚线（series 名「去年同期」，x 轴按月序号对齐）；图顶 `TimeRangeBar`（granularity 月/年）；`Skeleton` 占位（高 280）
- [x] **Step 3: 空态** —— 账本无数据时整页 `Empty` + 「去录入第一笔」Button（`Link to="/entry"`）
- [x] **Step 4: 验证**：typecheck + unit + 手动 dev 目测（测试账本）；e2e 新增最小用例（见 Task 7）
- [x] **Step 5: Commit** `feat(ui-d): 总览页指标卡 + 同比趋势 + 骨架加载`

### Task 4: 对账页 ReconcilePage（重写占位文件）

**Files:**
- Modify: `src/renderer/src/views/ReconcilePage.tsx`（批次 A 占位 → 完整页面，App.tsx 零改动）
- Create: `src/renderer/src/styles/views/reconcile.less`

**Interfaces:**
- Consumes: `getBalancesReport`（既有）、`accountNameMap` 模式（照抄 ReportsView 现有实现）、批次 A `.num`

- [x] **Step 1: Tab ① 科目余额表** —— `Table` 树形（`rowKey=name`，children 展开）：账户列（中文映射 + Tooltip 原名）+ 余额列（多币种 `balances.map(b => formatAmount(b.number) + ' ' + b.currency)`，`.num` 右对齐，负数 `.num-negative`）；顶部 `RangePicker` 传 `ReportBalancesParams`（既有参数）
- [x] **Step 2: Tab ② 明细账** —— `Empty description="需索引账户过滤查询支持（超 UI 层 #2），当前版本暂未开放"` 兜底占位（有 UI 无假数据）
- [x] **Step 3: 验证**：typecheck + unit + 手动 dev
- [x] **Step 4: Commit** `feat(ui-d): 对账页科目余额表（树表 + 千分位右对齐）`

### Task 5: 账户页 AccountsPage（重写占位文件）

**Files:**
- Modify: `src/renderer/src/views/AccountsPage.tsx`（批次 A 占位 → 完整页面，App.tsx 零改动）
- Modify: `src/renderer/src/views/AccountSettingsModal.tsx`（**保留文件**但录入页不再引用；若 e2e 无依赖则标记 deprecated 注释）
- Modify: `src/renderer/src/views/EntryFormView.tsx`（「账户设置」按钮 → `useNavigate()` 跳 `/accounts`；此时批次 B 已合并，基于其重排后的代码做最小改动）
- Create: `src/renderer/src/styles/views/accounts.less`

**Interfaces:**
- Consumes: `AccountSettingsModal` 现有全部逻辑（新增校验/删除限制/保存链路——`getAccountConfig` / `saveAccountConfig`），**逻辑原样搬移**，仅容器从 Modal 改页面

- [x] **Step 1: 页面结构** —— 左侧 `Tabs`（资产/负债/权益/收入/支出，按 `value` 首段过滤条目）+ 右侧编辑表（原 Table 列原样：ID/名称/用途/路径/删除）；页头 `Button type="primary" icon={<PlusOutlined>}`「新增科目」开 `Drawer`（内嵌原新增区三 Input + 类型 Radio，纵向排列替换 26%/30%/34% 定宽行）
- [x] **Step 2: 录入页跳转** —— `SettingOutlined` 按钮改 `onClick={() => navigate('/accounts')}`
- [x] **Step 3: 验证**：typecheck + unit + 手动 dev（新增/编辑/删除/保存全链路）
- [x] **Step 4: Commit** `feat(ui-d): 账户管理独立页（分类 Tabs + 抽屉新增），录入页按钮改跳转`

### Task 6: 设置页完善 + 跨批迁移

**Files:**
- Modify: `src/renderer/src/views/SettingsPage.tsx`（批次 A 占位 → 完整聚合页，App.tsx 零改动）
- Modify: `src/renderer/src/views/EntriesView.tsx`（迁出「索引状态」Card 与「清空账本」按钮至设置页——批次 B 已合并，顺序执行无冲突；「重建索引」按钮保留在明细页页头）

**Interfaces:**
- Consumes: 批次 C 的 `getWorkspaceRecents` + `switchWorkspace`（LedgerSwitcher 导出）、各设置 Modal（`SyncSettingsModal`/`AiSettingsModal`/`UpdateModal` **保留为 Modal**，设置页放触发卡片）

- [x] **Step 1: 迁移**：把 EntriesView 的索引状态 Descriptions + 清空账本（Modal.confirm 原逻辑整体搬移，逻辑零改动）移入设置页；ledger-index.spec 若断言受影响做最小调整
- [x] **Step 2: 区块结构** —— `Card` 分组：① 账本管理（recents 列表 List：每项 basenamePath + Tooltip 路径 + 「打开」按钮走 `switchWorkspace`；含清空账本按钮）② 同步（当前状态一行 + 「同步设置」开 Modal）③ AI 助手（配置状态 + 开 Modal）④ 索引状态（迁入内容归位此卡）⑤ 关于与更新（版本行 + 「检查更新」开 UpdateModal）
- [x] **Step 3: 验证**：typecheck + unit + 手动 dev
- [x] **Step 4: Commit** `feat(ui-d): 设置聚合页（账本管理/同步/AI/索引/更新）+ 索引卡/清空自明细页迁入`

### Task 7: E2E 与收尾

**Files:**
- Modify: `e2e/smoke.spec.ts`（追加：菜单「总览」默认选中、指标卡「总资产」可见）
- Modify: `e2e/ledger-index.spec.ts`（如明细页结构调整导致的必要微调）

- [x] **Step 1: 补 e2e**（最小断言：`menuitem '总览'` 可见 + `getByText('总资产')` 可见 + `menuitem '对账'`/`'账户'` 可见）
- [x] **Step 2:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [x] **Step 3:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree
