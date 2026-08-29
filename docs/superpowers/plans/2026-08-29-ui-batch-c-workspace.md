# 批次 C：账本切换（recents 全链路 + Dropdown + Ctrl+K）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 账本切换升级为财务软件心智：顶部 Dropdown 主入口（当前 + 最近 + 浏览）+ Ctrl+K 快捷弹层 + 未保存防误操作；打通主进程已有但未接线的 `workspace:recents` 能力。

**Architecture:** `workspace:recents` 按 IPC 标准链路补全三处（main handler 注册 → shared/api 类型 → preload 白名单）；`LedgerSwitcher` 增强为完整 Dropdown；新增 `useEntryFormDirty` zustand 微 store 供确认弹层判断；`QuickSwitchModal` 原生 antd 组合（零新依赖）。

**Tech Stack:** 现有栈，零新依赖。

**Spec:** `ui-optimization-plan.md` 模块 8、`docs/superpowers/plans/2026-08-29-ui-optimization-master.md`。

**Worktree:** `.worktrees/c-workspace`，分支 `ui/c-workspace`，基于含批次 A（建议 B 亦已合并）的 `ui-v4`。

**前置命令（会话开始时执行）：**

```bash
cd /f/raychaoo/BeanWise && git checkout ui-v4 && git worktree add .worktrees/c-workspace -b ui/c-workspace ui-v4 && cd .worktrees/c-workspace && npm install
```

## Global Constraints

见总计划「Global Constraints」。特别强调：切换成功后仍 `window.location.reload()`（CLAUDE.md 约束 9，**不做软切换**）；`workspace:recents` 是新增 IPC 能力（通道名已在 `src/shared/ipc.ts:30` 的 `IpcChannel` 中，store 方法 `loadRecents()` 已存在 `src/main/workspace-store.ts:24`），按标准链路补全，不改动任何已有 handler。

---

### Task 1: workspace:recents IPC 全链路

**Files:**
- Modify: `src/main/ipc-handlers-workspace.ts`（registerWorkspaceHandlers 内加一行 handler）
- Modify: `src/shared/api.ts`（`BeanWiseApi` 加 `getWorkspaceRecents(): Promise<string[]>`）
- Modify: `src/preload/index.ts`（白名单加 `getWorkspaceRecents: () => ipcRenderer.invoke('workspace:recents')`）
- Test: `src/main/ipc-handlers-workspace.test.ts`（若已存在则追加用例；否则新建，参照 `src/main/ipc-handlers.test.ts` 的 registrar 用法）

**Interfaces:**
- Produces: `window.beanwise.getWorkspaceRecents(): Promise<string[]>`（最近工作目录绝对路径数组，最新在前，上限 10——由 `WorkspaceStore.loadRecents()` 保证）

- [ ] **Step 1: 失败测试**（构造 `WorkspaceStore` 依赖的临时目录 fixture 或 mock store：`registerWorkspaceHandlers` 后调用 handler，断言返回 `loadRecents()` 结果）
- [ ] **Step 2: 跑失败** `npx vitest run src/main/ipc-handlers-workspace.test.ts` → FAIL
- [ ] **Step 3: 实现**：`ipc.handle('workspace:recents', (): string[] => deps.store.loadRecents())`（handler 内不接收参数，无入参校验面）
- [ ] **Step 4: 跑通过** → PASS；`npm run typecheck`
- [ ] **Step 5: Commit** `feat(ui-c): workspace:recents IPC 全链路（main/api/preload）`

### Task 2: 路径工具

**Files:**
- Create: `src/renderer/src/utils/path.ts`
- Test: `src/renderer/src/utils/path.test.ts`

**Interfaces:**
- Produces: `basenamePath(p: string): string`（按 `/` 与 `\` 双分隔符取末段，空串返回原值）

- [ ] **Step 1: 失败测试**（`'C:\\a\\b'`→`'b'`、`'/x/y'`→`'y'`、`'name'`→`'name'`）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现** `p.split(/[\\/]/).filter(Boolean).pop() ?? p`
- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: LedgerSwitcher 基础版换用 `basenamePath`**（删除批次 A 的临时内联实现）
- [ ] **Step 6: Commit** `feat(ui-c): basenamePath 工具 + LedgerSwitcher 复用`

### Task 3: LedgerSwitcher 完整版

**Files:**
- Modify: `src/renderer/src/views/LedgerSwitcher.tsx`（重写为完整 Dropdown）
- Create: `src/renderer/src/stores/entry-form.ts`
- Modify: `src/renderer/src/views/EntryFormView.tsx`（接线 dirty，≤3 行）
- Test: `src/renderer/src/stores/entry-form.test.ts`

**Interfaces:**
- Consumes: `getWorkspaceRecents`（Task 1）、`basenamePath`（Task 2）、`useLedgerStore`/`useSyncStore` 不动
- Produces: `useEntryFormStore`（`{ dirty: boolean; setDirty(v: boolean): void }`）；LedgerSwitcher 行为：当前账本（CheckOutlined + hover Tooltip 完整路径，disabled）→ 分隔线 → 最近账本（排除当前，逐项 `basenamePath`，hover Tooltip 完整路径）→ 分隔线 → `浏览其他目录…`（原 choose+open+reload 链路）→ 底部固定 `Menu.Item` 说明「每个目录独立账本与索引，切换后整页重载」（disabled）

- [ ] **Step 1: 失败测试 useEntryFormStore**（setDirty(true) → dirty true）
- [ ] **Step 2: 跑失败** → FAIL；**Step 3: 实现**；**Step 4: 跑通过**
- [ ] **Step 5: EntryFormView 接线**：`onValuesChange={() => useEntryFormStore.getState().setDirty(true)}`、提交成功 `resetFields` 后 `setDirty(false)`
- [ ] **Step 6: Dropdown 交互**：`onClick` 分派——`key === current` 忽略；recents 项 → `confirmSwitch(path)`；`browse` → 原链路。`confirmSwitch`：`useEntryFormStore.getState().dirty` 为 true 时先 `Modal.confirm({ title: '切换账本', content: '录入表单有未提交内容，切换后将丢失。确定切换？', okText: '切换', okButtonProps:{danger:true} })` 再走 `openWorkspace(path)` + 成功 `window.location.reload()`；失败 `message.error(result.message)`
- [ ] **Step 7: 验证**：typecheck + unit；手动 `npm run dev`（测试账本 `F:\BeanWiseData\test`）核对下拉与确认弹层
- [ ] **Step 8: Commit** `feat(ui-c): 账本 Dropdown 切换（recents + dirty 确认 + 路径 tooltip）`

### Task 4: Ctrl+K 快捷切换弹层

**Files:**
- Create: `src/renderer/src/views/QuickSwitchModal.tsx`
- Modify: `src/renderer/src/App.tsx`（挂载 Modal + 全局 keydown）

**Interfaces:**
- Consumes: Task 3 的 `confirmSwitch` 逻辑抽为 `switchWorkspace(path: string): Promise<void>`（从 LedgerSwitcher 导出或放 `src/renderer/src/utils/workspace.ts`，Dropdown 与 Modal 共用）

- [ ] **Step 1: QuickSwitchModal** —— `Modal`（title「切换账本」+ `Input` autoFocus placeholder「输入目录名过滤」）+ recents 过滤列表（`basenamePath` 包含匹配，不区分大小写）+ 键盘 ↑↓ 选择 / Enter 确认；选中即调 `switchWorkspace`
- [ ] **Step 2: 全局快捷键** —— App 内 `useEffect` 挂 `keydown`（`(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'` → setOpen(true)，`e.preventDefault()`）；组件卸载移除
- [ ] **Step 3: 验证**：typecheck + unit；`npm run test:e2e`（无新增 spec，回归全绿即可）
- [ ] **Step 4: Commit** `feat(ui-c): Ctrl+K 账本快捷切换弹层`

### Task 5: 批次收尾

- [ ] **Step 1:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [ ] **Step 2:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree
