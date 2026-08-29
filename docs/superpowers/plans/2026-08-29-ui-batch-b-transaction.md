# 批次 B：交易域（录入双栏重排 + 流水瘦身）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 录入页回归「录入」主战场（双栏布局、借贷语义、平衡提示、Excel/AI 抽屉化），流水页瘦身并加时间筛选与倒序。

**Architecture:** `EntryFormView` 拆出 `PostingRowCard`/`BalanceHint` 纯展示组件与 `balanceHintState` 纯函数；Excel/AI 面板包进 Drawer 仅换容器；`EntriesView` 移除索引状态卡（迁入批次 A 的 `/settings` 占位）并加前端时间筛选。

**Tech Stack:** 现有栈，零新依赖。样式写 `styles/views/entry.less`、`styles/views/entries.less`。

**Spec:** `ui-optimization-plan.md` 模块 3、`docs/superpowers/plans/2026-08-29-ui-optimization-master.md`（约束 + 契约）。

**Worktree:** `.worktrees/b-transaction`，分支 `ui/b-transaction`，基于含批次 A 的 `ui-v4`。

**并行说明：** 本批与批次 C、E **同时开工**（波次 2）。文件所有权：本批独占 `EntryFormView.tsx` / `views/entry/*` / `EntriesView.tsx` / `styles/views/entry*.less` / `utils/format.ts` / `utils/accountGroup.ts`；**不得改动** `App.tsx`、`LedgerSwitcher.tsx`、`ReportsView.tsx`、`preload/*`、`package.json`、四个占位页（DashboardPage/ReconcilePage/AccountsPage/SettingsPage——归 D 批）。合并前先 `git merge ui-v4` 同步主干再跑全量验证。

**前置命令（会话开始时执行；`git worktree add` 不需要也不应该 checkout 主 checkout）：**

```bash
cd /f/raychaoo/BeanWise && git worktree add .worktrees/b-transaction -b ui/b-transaction ui-v4 && cd .worktrees/b-transaction && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。特别强调：录入写路径（ProForm → `add-entry`、`nextBalancingNumber` 自动平衡、金额 stringMode）**逻辑零改动**；`e2e/ai-entry.spec.ts`、`e2e/ledger-index.spec.ts` 的表单 label（`交易对象`/`说明`/`账户`/`金额`/`货币`）与按钮 `写入账本` 文本**不得改**。

---

### Task 1: 金额千分位工具

**Files:**
- Create: `src/renderer/src/utils/format.ts`
- Test: `src/renderer/src/utils/format.test.ts`

**Interfaces:**
- Produces: `formatAmount(raw: string | null | undefined): string`（方案 2.3 节实现原样：正则校验 → 千分位插入 → 空值 `'—'`；负数带 `-`）

- [x] **Step 1: 失败测试**（用例：`'1234567.89'→'1,234,567.89'`、`'-1234.5'→'-1,234.5'`、`'0'→'0'`、`'abc'→'—'`、`null→'—'`、`''→'—'`）
- [x] **Step 2: 跑失败** `npx vitest run src/renderer/src/utils/format.test.ts` → FAIL
- [x] **Step 3: 实现**（方案 2.3 节代码原样，纯字符串处理，禁 Number/parseFloat）
- [x] **Step 4: 跑通过** → PASS
- [x] **Step 5: Commit** `feat(ui-b): 金额千分位格式化 formatAmount`

### Task 2: 账户分组下拉选项

**Files:**
- Create: `src/renderer/src/utils/accountGroup.ts`
- Test: `src/renderer/src/utils/accountGroup.test.ts`

**Interfaces:**
- Consumes: `AccountOption`（`src/renderer/src/stores/ledger.ts` 中类型，`{ label, value }`）
- Produces: `groupAccountOptions(options: AccountOption[]): Array<{ label: string; options: AccountOption[] }>` —— 按 `value` 首段（`Assets|Liabilities|Equity|Income|Expenses`）分组，组标签用中文（资产/负债/权益/收入/支出），未知首段归入「其他」组置底

- [x] **Step 1: 失败测试**（Assets/Liabilities/未知前缀混排 → 5 组顺序 + 其他组置底；组内保持原序）
- [x] **Step 2: 跑失败** → FAIL
- [x] **Step 3: 实现**（`Map` 分组 + 固定组序数组）
- [x] **Step 4: 跑通过** → PASS
- [x] **Step 5: Commit** `feat(ui-b): 账户下拉按五大类分组 groupAccountOptions`

### Task 3: 录入页双栏重排 + 分录卡 + 平衡提示

**Files:**
- Create: `src/renderer/src/views/entry/PostingRowCard.tsx`
- Create: `src/renderer/src/views/entry/BalanceHint.tsx`
- Create: `src/renderer/src/styles/views/entry.less`
- Modify: `src/renderer/src/views/EntryFormView.tsx`（布局重排，逻辑不动）
- Test: `src/renderer/src/views/entry-hint.test.ts`

**Interfaces:**
- Consumes: `nextBalancingNumber`（EntryFormView 已导出，勿动）、`computeBalancingNumber`（shared/decimal）、`groupAccountOptions`（Task 2）、`filterAccountOptions`（shared/account，保持现有互斥过滤）
- Produces: `balanceHintState(rows: Array<{number?: string|null}>|undefined): { kind: 'balanced'|'diff'|'none'; text: string }`；`PostingRowCard` props `{ index: 0|1; currencyOptions; accountOptions }`

- [x] **Step 1: 失败测试 balanceHintState**（用例：前 n-1 行有值末行空 → `{kind:'diff', text:'将自动平衡为 X'}`（X=`computeBalancingNumber` 结果经 formatAmount）；全部行和为 0 → `{kind:'balanced', text:'借贷已平衡'}`；无任何金额 → `{kind:'none', text:''}`；金额非法 → `{kind:'none'}`——非法交给表单校验）
- [x] **Step 2: 跑失败** → FAIL
- [x] **Step 3: 实现 balanceHintState**（内部复用 `computeBalancingNumber`，异常走 `'none'`）
- [x] **Step 4: 跑通过** → PASS
- [x] **Step 5: PostingRowCard**（方案模块 3 代码骨架原样：蓝/橙左边条 + 头部语义文案 + 账户 Select 分组 options + 金额 stringMode `controls={false}` + 货币 AutoComplete；**保留 Form.Item 的 name/rules 由父级传入**——rules 数组经 props `accountRules`/`numberRules` 传入以不破坏校验）
- [x] **Step 6: entry.less**（方案模块 3 less 原样 + `.balance-hint`：绿 `@bw-inflow`/红 `@bw-negative` 两态）
- [x] **Step 7: EntryFormView 重排**：外层 `flex` 双栏（左 `flex:3` 凭证卡：凭证头 2 列栅格 + 两张 PostingRowCard + BalanceHint + 提交区[写入账本 + 重置 Button]；右 `flex:2` 卡片：`Empty`「最近流水（批次 D 接入总览联动）」占位）；ExcelImportPanel/AiEntryPanel 先从首屏移除（Task 4 处理）；Form.Item 的 `label` 保持 `账户/金额/货币`（E2E 依赖 `getByLabel`）——PostingRowCard 内 label 用 `Form.Item` 原生 label，占位符另加语义文案
- [x] **Step 8: Ctrl+Enter 提交**：ProForm `onFinish` 挂 keydown 监听（`e.ctrlKey && e.key === 'Enter'` → `form.submit()`），组件卸载移除监听
- [x] **Step 9: dirty 接线（批次 C 消费的契约）**：ProForm `onValuesChange={() => useEntryFormStore.getState().setDirty(true)}`（store 由批次 A 提供 `stores/entry-form.ts`）；提交成功 `resetFields` 后 `setDirty(false)`
- [x] **Step 10: 验证**：typecheck + unit；`npm run test:e2e -- --grep "录入|index"`（ai-entry/ledger-index 两 spec 全绿）
- [x] **Step 11: Commit** `feat(ui-b): 录入双栏重排 + 分录借贷卡 + 实时平衡提示 + Ctrl+Enter + dirty 上报`

### Task 4: Excel/AI 面板抽屉化

**Files:**
- Modify: `src/renderer/src/views/EntryFormView.tsx`（页头两个次要按钮触发 Drawer）
- Create: `src/renderer/src/views/entry/EntryActionsBar.tsx`

**Interfaces:**
- Consumes: `ExcelImportPanel`（props 不变，原样塞进 Drawer）、`AiEntryPanel`（props `onFillForm` 不变）

- [x] **Step 1: EntryActionsBar** —— `Space`：`Button icon={<FileExcelOutlined>}>Excel 导入</Button>`（开 Drawer width 720，内嵌 `<ExcelImportPanel onImported={...}>`）+ `Button icon={<RobotOutlined>}>AI 录入</Button>`（仅 `aiStatus.configured` 时渲染按钮，开 Drawer 内嵌 `<AiEntryPanel onFillForm>`，`onFillForm` 调用后**自动关 Drawer** 并 message 成功——复用现有 `handleFillForm`）
- [x] **Step 2: 验证**：`npm run test:e2e -- --grep "ai"`（AI 面板逻辑未变，spec 若依赖面板默认可见则改为先点「AI 录入」按钮——按 spec 实际断言调整并保持最小改动）
- [x] **Step 3: Commit** `feat(ui-b): Excel/AI 录入入口抽屉化，录入首屏去杂`

### Task 5: 流水页时间筛选 + 倒序

**Files:**
- Modify: `src/renderer/src/views/EntriesView.tsx`
- Create: `src/renderer/src/styles/views/entries.less`
- Test: e2e/ledger-index.spec.ts 断言核对

**Interfaces:**
- Consumes: Task 1 `formatAmount`（错误信息等数值展示）

- [x] **Step 1: 页头筛选**：保留「重建索引」按钮在页头（`e2e/ledger-index.spec.ts:35` 依赖，**必须保留**）；「索引状态」Card 与「清空账本」按钮**本批原样保留**（迁移到设置页由批次 D 收口时执行，避免与 D 批占位文件冲突）；`Table` 加 `sorter` 于 date 列（`defaultSortOrder: 'descend'`）；页头加 `Segmented`（今日/本周/近7天/本月/全部）+ `DatePicker.RangePicker`，前端过滤已加载数据（`entries.filter(date in range)`），并在 Segmented 旁加 `Tooltip`「筛选作用于已加载分页数据；全量时间筛选需索引查询支持（超 UI 层 #2）」
- [x] **Step 2: 验证**：typecheck + unit + `npm run test:e2e` 全量
- [x] **Step 3: Commit** `feat(ui-b): 流水页时间快捷筛选 + 日期倒序`

### Task 6: 批次收尾

- [x] **Step 1:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [x] **Step 2:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree
