# 批次 F：明细账账户过滤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 `ListEntriesParams.account` 服务端账户过滤，对账页「明细账」Tab 接真数据，删除占位 Empty。

**Architecture:** 查询在 `src/main/index-builder.ts` 的 listEntries SQL 加可选 `account` 精确匹配（postings 表逐行）；渲染端 `ReconcilePage` Tab② 用 TreeSelect 选账户 → 分页拉取该账户分录行。类型经 `shared/ipc.ts` 转出，**无 preload/api 改动**。

**Tech Stack:** 现有栈，零新依赖。

**Spec:** `2026-08-30-capability-batches-master.md`（契约 + 约束）、`ui-optimization-plan.md` 模块 5。

**Worktree:** `.worktrees/f-entry-account-filter`，分支 `ui/f-entry-account-filter`，基于 ui-v4 HEAD。

**前置命令（会话开始时执行；不需要 checkout 主 checkout）：**

```bash
cd /f/raychaoo/BeanWise && git worktree add .worktrees/f-entry-account-filter -b ui/f-entry-account-filter ui-v4 && cd .worktrees/f-entry-account-filter && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。本批独占 `index-builder.ts`（listEntries）与 `ReconcilePage.tsx`；**不改** `shared/ipc.ts`、`preload/*`、`package.json`、其他页面。

---

### Task 1: ListEntriesParams.account 查询

**Files:**
- Modify: `src/main/index-builder.ts`（`ListEntriesParams` 加 `account?: string`；listEntries 查询函数加过滤）
- Test: `src/main/index-builder.test.ts`（追加用例）

**Interfaces:**
- Produces: `ListEntriesParams.account?: string` —— 语义：**精确匹配** `postings.account`（不做前缀展开；层级聚合是余额表职责）；命中行的同笔交易其他 posting 行**不**自动带出（明细账视角=该账户自身分录流）；`account` 与 `keyword`/`dateFrom`/`dateTo` 可叠加，均 AND 语义

- [ ] **Step 1: 失败测试**（fixture 账本含 Breakfast: Expenses:Food + Assets:Bank 两行；`listEntries({ account: 'Expenses:Food' })` 只返回 Food 行，total=该账户行数；`account` 与 `dateFrom` 叠加生效；未知账户返回空）
- [ ] **Step 2: 跑失败** `npx vitest run src/main/index-builder.test.ts` → FAIL
- [ ] **Step 3: 实现**：入参校验（`account` 为非空字符串，长度上限 200）；SQL 在现有 WHERE 链上加 `eq(postings.account, account)`（drizzle 参数化，无注入面）；`total` 计数同条件
- [ ] **Step 4: 跑通过** → PASS；`npm run typecheck`
- [ ] **Step 5: Commit** `feat(cap-f): listEntries 账户精确过滤参数`

### Task 2: 明细账 Tab 接真数据

**Files:**
- Modify: `src/renderer/src/views/ReconcilePage.tsx`（Tab② 重写，删除占位 Empty）
- Create: `src/renderer/src/styles/views/reconcile.less`（如已有则追加）

**Interfaces:**
- Consumes: Task 1 参数、`window.beanwise.listLedgerEntries`（既有 preload）、`accountOptions`（ledger store）、`formatAmount`（utils/format）、`.num` 类

- [ ] **Step 1: 筛选区** —— `TreeSelect`（数据源 `accountOptions` 按五大类分组，`treeNodeFilterProp="label"`，allowClear）+「查询」按钮；选择后 `loadEntries({ account, order: 'desc', limit: 20, offset })`
- [ ] **Step 2: 明细表** —— `Table` 列：日期 / 交易对象 / 说明 / 账户（中文映射 + Tooltip 原名）/ 金额（`formatAmount(row.amount)`，`.num` 右对齐，`amount === null` 显示 `—`）/ 币种；`order: 'desc'` 默认倒序；分页同 EntriesView 模式（`total` + `offset`）；本地状态 `useState` 保存当前查询参数，切换账户重置页码
- [ ] **Step 3: 空态与加载** —— 未选账户：`Empty description="选择账户后查看其明细分录"`；选中无数据：`Empty description="该账户暂无分录"`；加载态 Table `loading`
- [ ] **Step 4: 验证**：typecheck + unit；`npm run dev`（测试账本）手动核对；`npm run test:e2e -- --grep "ledger|index"` 回归
- [ ] **Step 5: Commit** `feat(cap-f): 对账页明细账 Tab 接真数据（账户过滤 + 金额列）`

### Task 3: E2E 与收尾

- [ ] **Step 1: e2e**（`e2e/reconcile.spec.ts` 新增最小用例：进对账页 → Tab② TreeSelect 选 Expenses:Food → 表格出现行且账户列含 Food；fixture 复用 `createFixtureCopy` 模式）
- [ ] **Step 2:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [ ] **Step 3:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree
