# 批次 I：科目期初余额 + 启停用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `AccountEntry` 增 `enabled` 字段（停用账户不进录入下拉）与期初余额能力——通过**既有 `ledger:add-entry` 通道**生成 Equity:Opening-Balances 配对交易落账本，Beancount 文件保持唯一事实源。

**Architecture:** 期初余额不存配置文件（避免双源）：用户在账户页输入 金额/货币/日期 → 纯函数组合成 `AddEntryParams` → 确认弹层 → 既有 add-entry 写入 → refresh。启停用是纯配置字段，过滤发生在渲染端 `mergeAccountOptions`。

**Tech Stack:** 现有栈，零新依赖。

**Spec:** `2026-08-30-capability-batches-master.md`（契约 + 约束）、`ui-optimization-plan.md` 模块 4。

**Worktree:** `.worktrees/i-account-config`，分支 `ui/i-account-config`，基于 ui-v4 HEAD。

**前置命令（会话开始时执行；不需要 checkout 主 checkout）：**

```bash
cd /f/raychaoo/BeanWise && git worktree add .worktrees/i-account-config -b ui/i-account-config ui-v4 && cd .worktrees/i-account-config && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。本批独占 `shared/ipc.ts`（AccountEntry 接口段）、`stores/ledger.ts`（mergeAccountOptions）、`AccountsPage.tsx`、`account-config-store.ts`（如需）。**不改** `preload/*`（新字段随类型流转）、`EntryFormView.tsx`、`App.tsx`、`package.json`。红线：不引入第二写路径——期初余额只走 `add-entry`。

---

### Task 1: AccountEntry.enabled 字段与存储透传

**Files:**
- Modify: `src/shared/ipc.ts`（`AccountEntry` 加 `/** 停用后不进录入下拉；缺省视为启用 */ enabled?: boolean`）
- Modify: `src/main/account-config-store.ts`（若保存/读取为显式字段映射则补透传；若整体序列化则确认无丢弃）
- Test: `src/main/account-config-store.test.ts`（追加：enabled=false 保存后读回保持）

- [x] **Step 1: 失败测试**（save 带 enabled:false 的条目 → load 读回 enabled === false；不带 enabled → 读回 undefined）
- [x] **Step 2: 跑失败** → FAIL（typecheck 层：`enabled` 不在 AccountEntry 类型上；store 为整体序列化，运行时天然透传）
- [x] **Step 3: 实现透传**；**Step 4: 跑通过** + `npm run typecheck`
- [x] **Step 5: Commit** `feat(cap-i): AccountEntry.enabled 字段与存储透传`
- [x] 补充修复（执行会话发现）：store 层无丢弃，但 IPC 层 `normalizeAccounts` 显式映射 `{id,name,value,description}` 会剥离 enabled——已补透传 + IPC 全链路回归测试（`fix(cap-i): accounts:save 透传 enabled 字段`，由 e2e 首先暴露）

### Task 2: 录入下拉过滤停用账户

**Files:**
- Modify: `src/renderer/src/stores/ledger.ts`（`mergeAccountOptions` 中排除 `enabled === false` 的**配置库**条目）
- Test: `src/renderer/src/stores/ledger.test.ts`（追加；若无该文件参照相邻 store 测试新建）

**Interfaces:**
- 语义边界（写进实现注释）：只有**账户库配置条目**可停用；账本中存在但账户库没有的账户（历史交易产生）无停用载体，始终出现。停用不影响明细/报表展示与账户设置页编辑。

- [x] **Step 1: 失败测试**（config 3 条其中 1 条 enabled=false + ledger 账户 2 个 → accountOptions 不含停用项，含其余）
- [x] **Step 2: 跑失败** → FAIL
- [x] **Step 3: 实现**（merge 时 `entry.enabled === false` 跳过）
- [x] **Step 4: 跑通过** → PASS
- [x] **Step 5: Commit** `feat(cap-i): 录入下拉过滤停用账户`
- 语义补充：停用配置账户即使账本有历史交易也不回灌下拉（configuredValues 按全量去重防其以历史账户身份再次入选），有专门测试固化

### Task 3: 期初余额组合纯函数

**Files:**
- Create: `src/renderer/src/utils/opening-balance.ts`
- Test: `src/renderer/src/utils/opening-balance.test.ts`

**Interfaces:**
- Consumes: `AddEntryParams`（shared/ipc）
- Produces: `buildOpeningBalanceEntry(input: { account: string; number: string; currency: string; date: string }): AddEntryParams | { error: string }` —— postings：`[{ account, number, currency }, { account: 'Equity:Opening-Balances', number: <computeBalancingNumber([number]) 取反即对方行>, currency }]`；narration `'期初余额'`；flag `'*'`；校验：金额非负、正则合法、账户非 PnL（`accountType` 非 Income/Expenses——期初余额只对资产/负债账户有意义，违规返回 `{ error }`）

- [x] **Step 1: 失败测试**（合法资产账户 → 两行结构且和为 0、narration 正确；负数金额 → error；Income 账户 → error；非法金额格式 → error）
- [x] **Step 2: 跑失败** `npx vitest run src/renderer/src/utils/opening-balance.test.ts` → FAIL
- [x] **Step 3: 实现**（金额运算用 `computeBalancingNumber`/字符串取反，禁 Number）
- [x] **Step 4: 跑通过** → PASS（对方行值遵循 decimal.ts「无尾随零」规范化契约，如 1000.50 → -1000.5）
- [x] **Step 5: Commit** `feat(cap-i): 期初余额组合纯函数 buildOpeningBalanceEntry`

### Task 4: 账户页 UI（启停用 + 期初余额入口）

**Files:**
- Modify: `src/renderer/src/views/AccountsPage.tsx`

**Interfaces:**
- Consumes: Task 1/2/3 产物、既有 `saveAccountConfig` / `addLedgerEntry` / `useLedgerStore.refresh`

- [x] **Step 1: 状态列** —— 编辑表加「状态」列 `Switch`（checked = `enabled !== false`）；切换即改本地条目，随既有「保存」按钮一起 `saveAccountConfig`（保持「显式保存」模型，避免误触即写盘）
- [x] **Step 2: 期初余额入口** —— 每行操作列加「期初余额」（仅 Assets/Liabilities 类型行显示）；`Modal`：金额 InputNumber(stringMode) + 货币 AutoComplete（默认运营货币）+ 日期 DatePicker（默认今天）→ 确定调 `buildOpeningBalanceEntry`，error 时 `message.error`；成功走 `Modal.confirm` 预览（展示将生成的两行分录摘要 + 「将在账本新增一笔可编辑交易」）→ `addLedgerEntry` → 成功 `message.success` + `useLedgerStore.getState().refresh()`
- [x] **Step 3: open 指令验证** —— **实测结论：add-entry 对未 open 账户自动补 open 行，无需 UI 兜底提示。** 证据：`src/main/ipc-handlers.ts:162-184` 追加写前 `findUnopenedAccounts` + `serializeOpenLines`（首文件场景 `serializeFirstEntryBlock` 同样生成 open 行）；既有单测 `ipc-handlers-entry.test.ts:171-183` 断言未 open 的 Expenses:Food 被自动补 open；本批 e2e 亦断言未 open 的 Assets:Cash 期初写入后账本出现 `open Assets:Cash` 行。「请先添加 open 行」提示分支不存在，Modal 仅透传 add-entry 失败 message
- [x] **Step 4: 验证**：typecheck + unit 全绿；手动 dev 检查项以新增 e2e 自动化（`e2e/account-config.spec.ts` 两用例）：停用 → 保存 → enabled 落盘 → 录入选择器无停用账户；期初余额 → 账本出现 Equity:Opening-Balances 配对（含未 open 自动补 open）→ 重建索引平衡。过程中另修一处真 bug：zustand 选择器内 `?? []` 新建数组致 React #185 无限重渲染（慢机器 status 未就绪时崩溃），改为渲染体内派生
- [x] **Step 5: Commit** `feat(cap-i): 账户页启停用开关与期初余额录入（走 add-entry）`

### Task 5: 批次收尾

- [ ] **Step 1:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿（与并行批次错峰跑 e2e）
- [ ] **Step 2:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree
