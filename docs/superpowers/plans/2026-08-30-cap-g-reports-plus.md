# 批次 G：报表域扩展（日/周粒度 + 三栏余额表 + 现金流量表 + PDF 导出）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次收口报表域四项：`ReportGranularity` 扩到日/周（清单 #4）、对账页三栏式科目余额表（期初/发生/期末，#5）、现金流量表（#7）、报表导出 PDF（#8）。

**Architecture:** 聚合全部在主进程 `report-aggregation.ts` 纯函数层扩展（SQLite 行 → decimal 字符串，禁 SQL SUM），新增 `report:trial-balance` / `report:cash-flow` / `report:export-pdf` 三通道走标准链路；前端 ReportsView 加现金流量 Tab + 导出按钮，ReconcilePage Tab① 升级三栏，TimeRangeBar/DashboardPage 放开粒度。**必须在 F/H/I 合并后开工**（本批独占 ReconcilePage Tab① 与 shared/ipc.ts report 段）。

**Tech Stack:** 现有栈，零新依赖；PDF 用 Electron 内建 `webContents.printToPDF`。

**Spec:** `2026-08-30-capability-batches-master.md`（契约 + 约束）、`ui-optimization-plan.md` 模块 2/5/6。

**Worktree:** `.worktrees/g-reports-plus`，分支 `ui/g-reports-plus`，基于含 F/H/I 的 `ui-v4`。

**前置命令（会话开始时执行；不需要 checkout 主 checkout）：**

```bash
cd /f/raychaoo/BeanWise && git worktree add .worktrees/g-reports-plus -b ui/g-reports-plus ui-v4 && cd .worktrees/g-reports-plus && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。**红线**：`reports.spec.ts` 依赖的默认 Tab 卡片标题（净资产趋势/收支对比/账户余额）与起始年/结束年 Select 不得动；所有新聚合先写纯函数单测（decimal 字符串运算）再接 IPC；e2e 不新增对 canvas 内容的断言。

---

### Task 1: 日/周粒度聚合

**Files:**
- Modify: `src/main/report-aggregation.ts`（`computeNetWorth` / `computeIncomeExpense` 支持 `'day' | 'week'`）
- Modify: `src/shared/ipc.ts`（`ReportGranularity = 'day' | 'week' | 'month' | 'year'`）
- Modify: `src/main/ipc-handlers-report.ts`（`validateGranularity` 放行新值；`report:years` 等不受影响）
- Test: `src/main/report-aggregation.test.ts`（追加）

**Interfaces:**
- Produces: period key 语义——`day` = `date` 原值；`week` = ISO 周标签 `YYYY-Www`（手写 ISO 周计算或 `dayjs` isoWeek 插件——dayjs 已是依赖，`import dayjs from 'dayjs'; import isohw from 'dayjs/plugin/isoWeek'` 需在主进程引入 dayjs；若主进程不便引 dayjs 则手写 ISO 周算法并单测覆盖跨年边界）；月/年行为不变（既有测试不破）

- [x] **Step 1: 失败测试**（行集跨 3 天/跨年周界：day 粒度逐日聚合金额正确；week 粒度跨年周归属正确（如 2026-12-29 属 2026-W53 还是 2027-W01 按 ISO 规则断言）；month/year 既有用例全保持）
- [x] **Step 2: 跑失败** `npx vitest run src/main/report-aggregation.test.ts` → FAIL
- [x] **Step 3: 实现**（period 抽取抽为 `periodKey(date, granularity)` 纯函数；金额累加继续 `addDecimalStrings`）
- [x] **Step 4: 跑通过** → PASS；typecheck
- [x] **Step 5: Commit** `feat(cap-g): 报表日/周粒度聚合`

### Task 2: 前端粒度放开

**Files:**
- Modify: `src/renderer/src/components/TimeRangeBar.tsx`（granularity Segmented 加 日/周 选项）
- Modify: `src/renderer/src/views/DashboardPage.tsx`（透传新粒度；无逻辑改动）

- [x] **Step 1:** Segmented options 加 `{label:'日',value:'day'},{label:'周',value:'week'}`；DashboardPage store 类型随 `ReportGranularity` 自动放宽，typecheck 通过即可
- [x] **Step 2: 验证**：typecheck；`npm run test:e2e -- --grep "报表"` 回归
- [x] **Step 3: Commit** `feat(cap-g): 粒度选择器放开日/周`

### Task 3: 三栏式科目余额表

**Files:**
- Modify: `src/main/report-aggregation.ts`（新增 `computeTrialBalance(rows, opts: { dateFrom?: string; dateTo?: string; currency?: string }): TrialBalanceRow[]`）
- Modify: `src/main/ipc-handlers-report.ts` + `src/shared/ipc.ts`（新通道 `report:trial-balance`，入参 `ReportTrialBalanceParams { dateFrom?, dateTo? }`，行类型 `TrialBalanceRow { name: string; opening: TrialBalanceCell; period: TrialBalanceCell; closing: TrialBalanceCell }`，`TrialBalanceCell { number: string; currency: string }`——多币种时每账户多行或 cell 数组，**取简化：每账户每币种一行**）
- Modify: `src/preload/index.ts` + `src/shared/api.ts`（`getTrialBalanceReport`）
- Modify: `src/renderer/src/views/ReconcilePage.tsx`（Tab① 升级三栏）
- Test: `src/main/report-aggregation.test.ts`（追加）

**Interfaces:**
- Produces: 三栏语义——`opening` = dateFrom 之前（不含）该账户累计净额；`period` = [dateFrom, dateTo] 区间内净发生额；`closing` = opening + period（`addDecimalStrings`）；无 dateFrom 时 opening 从账本首笔起算；资产/负债方向按账户类型展示正负（Assets/Expenses 余额为正方向，Liabilities/Equity/Income 取负债视角正值——与方案「红色仅负数」一致，方向语义写注释）
- Tab① UI：保留现有范围筛选，表格列 = 账户（层级缩进，中文映射）/ 期初 / 发生 / 期末（全部 `.num` 右对齐，负数 `.num-negative`）；币种筛选 Tag；空态保留

- [ ] **Step 1: 失败测试**（跨区间行集：opening/period/closing 三值与手算一致；无 dateFrom 时 opening=0；多币种分行；空区间安全）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现聚合**（复用既有 rows 读取模式；**禁 SQL SUM**，JS 端 `addDecimalStrings`）
- [ ] **Step 4: 跑通过**；handler + preload 接线；`npm run typecheck`
- [ ] **Step 5: ReconcilePage Tab① 三栏表格**
- [ ] **Step 6: 验证**：unit + `npm run dev` 手动核对（期初+发生=期末；与报表页净资产勾稽）
- [ ] **Step 7: Commit** `feat(cap-g): 三栏式科目余额表（report:trial-balance）`

### Task 4: 现金流量表

**Files:**
- Modify: `src/main/report-aggregation.ts`（`computeCashFlow(rows, opts: { granularity; currency?; dateFrom?; dateTo? }): CashFlowPoint[]`）
- Modify: `src/main/ipc-handlers-report.ts` + `src/shared/ipc.ts`（新通道 `report:cash-flow`，`CashFlowPoint { period: string; inflow: string; outflow: string; net: string }`）
- Modify: `src/preload/index.ts` + `src/shared/api.ts`（`getCashFlowReport`）
- Create: `src/renderer/src/views/reports/CashFlowTable.tsx`
- Modify: `src/renderer/src/views/ReportsView.tsx`（Tabs 加「现金流量表」）
- Test: `src/main/report-aggregation.test.ts`（追加）

**Interfaces:**
- **口径（写进实现与 UI 说明）**：现金池 = `Assets:` 顶层组全部账户（个人记账语境的资金池假设；后续如需精确圈定现金账户再立需求）。`inflow` = 区间内非 Assets→Assets 的流入（收入/对方转入）；`outflow` = Assets→非 Assets 流出；池内互转不计；`net` = inflow - outflow（字符串减法用 `computeBalancingNumber([inflow, 取反outflow])` 模式或新增本地 `subtractDecimalStrings`——若无则用 `addDecimalStrings(a, negate(b))`，`negate` 复用既有取反逻辑）
- UI：报告式上下结构——期间选择（复用 granularity + 起止）；表格列 期间/流入/流出/净额（`.num`）；顶部固定说明行「口径：Assets 组全部账户视为资金池」

- [ ] **Step 1: 失败测试**（构造 行集：收入→Assets、Assets→Expenses、Assets 内部互转、Liabilities 还款；断言 inflow/outflow 正确、互转不计、net 正确、period 分组正确）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现聚合 + IPC 接线**
- [ ] **Step 4: CashFlowTable 组件 + ReportsView Tab**（默认 Tab 结构不动，e2e 安全）
- [ ] **Step 5: 验证**：unit + `npm run test:e2e -- --grep "报表"`
- [ ] **Step 6: Commit** `feat(cap-g): 现金流量表（report:cash-flow，Assets 资金池口径）`

### Task 5: 报表导出 PDF

**Files:**
- Modify: `src/main/ipc-handlers-report.ts`（新通道 `report:export-pdf`）——或按项目惯例落 `src/main/ipc-handlers.ts`（执行时以现有 report handler 所在文件为准）
- Modify: `src/shared/ipc.ts` + `src/preload/index.ts` + `src/shared/api.ts`（`exportReportPdf(): Promise<{ ok: boolean; path?: string; message?: string }>`）
- Modify: `src/renderer/src/views/ReportsView.tsx`（页头「导出 PDF」按钮）
- Modify: `src/renderer/src/styles/views/reports.less`（`@media print` 打印隔离）
- Test: handler 单测（mock `webContents.printToPDF` 返回 Buffer + mock dialog）

**Interfaces:**
- Produces: handler 行为——取 `BrowserWindow.getFocusedWindow()`（无则 `getAllWindows()[0]`）的 `webContents.printToPDF({ printBackground: true, pageSize: 'A4' })` → `dialog.showSaveDialog`（默认文件名 `BeanWise-报表-<today>.pdf`）→ `writeFile` → 返回 `{ ok: true, path }`；取消保存返回 `{ ok: true }`（无 path）；渲染端按钮 loading 态 + 成功 `message.success('已导出: ' + path)`
- 打印样式：`@media print` 下隐藏 ProLayout 侧栏/Header/筛选工具栏/非激活 Tab 与本按钮自身，`.page-scroll` 高度 auto、overflow visible；仅当前报表区输出（类名 `print-area` 标注到激活 Tab 内容容器）

- [ ] **Step 1: 失败测试**（mock printToPDF/dialog/writeFile：成功路径返回 path；保存取消不写文件；打印异常返回 ok:false）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现 handler + 通道链路**
- [ ] **Step 4: 按钮 + @media print 隔离**
- [ ] **Step 5: 验证**：unit；`npm run dev` 实际导出一份 PDF 打开核对（表格线/数字右对齐/无导航元素）
- [ ] **Step 6: Commit** `feat(cap-g): 报表导出 PDF（printToPDF + 打印隔离样式）`

### Task 6: 批次收尾

- [ ] **Step 1:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [ ] **Step 2:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree；至此「超 UI 层清单」全部落地，在 `CLAUDE.md` IPC 域表格补三通道说明（report:trial-balance / report:cash-flow / report:export-pdf）
