# 批次 H：账本管理（重命名/归档/删除）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `workspace:rename` / `workspace:archive` / `workspace:delete` 三个 IPC 通道，设置页账本管理卡提供操作入口；打通清单 #3。

**Architecture:** 三个 handler 全部走**白名单校验**（只允许操作 `current`/`recents` 中已登记的目录，天然防目录穿越）；磁盘操作用 `fs.renameSync`（重命名/归档=移动到 `.beanwise-archive/`）与 `fs.rmSync`（删除）；store 同步维护 current/recents。渲染端仅 SettingsPage 改动。

**Tech Stack:** 现有栈，零新依赖。

**Spec:** `2026-08-30-capability-batches-master.md`（契约 + 约束）、`ui-optimization-plan.md` 模块 8。

**Worktree:** `.worktrees/h-workspace-mgmt`，分支 `ui/h-workspace-mgmt`，基于 ui-v4 HEAD。

**前置命令（会话开始时执行；不需要 checkout 主 checkout）：**

```bash
cd /f/raychaoo/BeanWise && git worktree add .worktrees/h-workspace-mgmt -b ui/h-workspace-mgmt ui-v4 && cd .worktrees/h-workspace-mgmt && npm install --ignore-scripts
```

## Global Constraints

见总计划「Global Constraints」。本批独占 `workspace-store.ts`、`ipc-handlers-workspace.ts`、`shared/ipc.ts`（workspace 段）、`preload/index.ts`、`shared/api.ts`、`SettingsPage.tsx`。**红线**：不改动既有四通道行为；删除/归档必须二次确认；任何路径操作前校验在白名单内。

---

### Task 1: workspace-store 扩展

**Files:**
- Modify: `src/main/workspace-store.ts`
- Test: `src/main/workspace-store.test.ts`（新建或追加）

**Interfaces:**
- Produces: `removeRecent(path: string): void`（从 recents 移除，若是 current 同时清空 current）；`replaceRecent(oldPath: string, newPath: string): void`（recents 中原位替换；若是 current 同时更新 current）

- [ ] **Step 1: 失败测试**（临时 electron-store 注入或 mock：removeRecent 移除指定项且保持顺序；replaceRecent 原位替换；操作 current 时联动）
- [ ] **Step 2: 跑失败** `npx vitest run src/main/workspace-store.test.ts` → FAIL
- [ ] **Step 3: 实现**（≤20 行）
- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** `feat(cap-h): workspace-store removeRecent/replaceRecent`

### Task 2: 三个 IPC handler（白名单 + 磁盘操作）

**Files:**
- Modify: `src/main/ipc-handlers-workspace.ts`
- Modify: `src/shared/ipc.ts`（`IpcChannel` 加 `'workspace:rename' | 'workspace:archive' | 'workspace:delete'`；新增 `WorkspaceOpResult { ok: boolean; message?: string; newPath?: string }` 与入参类型）
- Test: `src/main/ipc-handlers-workspace.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 store 方法、既有 `WorkspaceDeps.onWorkspaceChanged`（重命名当前目录时重建运行时用）
- Produces: handler 语义（全部返回 `WorkspaceOpResult`）：
  - `workspace:rename { path, newName }`：path ∈ 白名单；`newName` 校验 `/^[\w\u4e00-\u9fa5-]{1,100}$/`（禁路径分隔符与 `..`）；目标同父目录不存在重名；`renameSync`；`replaceRecent(path, newPath)`；若重命名的是 current → `onWorkspaceChanged(newPath)`；成功返回 `newPath`
  - `workspace:archive { path }`：path ∈ 白名单；移动到 `<parent>/.beanwise-archive/<basename>-<yyyymmddHHmmss>`（父目录不存在则 `mkdirSync`）；`removeRecent(path)`；若是 current → 渲染端将整页 reload 回门控（handler 返回后由渲染端处理）
  - `workspace:delete { path }`：path ∈ 白名单 **且 path !== current**（删除当前账本拒绝，`ok:false`）；`rmSync(path, { recursive: true, force: false })`；`removeRecent(path)`

- [ ] **Step 1: 失败测试**（fixture：临时目录建 3 个假工作目录登记进 store；重命名成功且 current 联动；重名拒绝；非法 newName 拒绝；白名单外路径拒绝；archive 移动到位且 recents 清除；delete 非 current 成功、current 拒绝）
- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（`existsSync` 前置校验 + try/catch 包裹，错误 `{ ok:false, message:String(err) }`）
- [ ] **Step 4: 跑通过** → PASS；`npm run typecheck`
- [ ] **Step 5: Commit** `feat(cap-h): workspace rename/archive/delete 三通道（白名单校验）`

### Task 3: preload/api 暴露

**Files:**
- Modify: `src/preload/index.ts`（`renameWorkspace / archiveWorkspace / deleteWorkspace` 三行）
- Modify: `src/shared/api.ts`（`BeanWiseApi` 三方法签名，入参/返回用 Task 2 类型）

- [ ] **Step 1:** 补三行白名单与类型；`npm run typecheck`
- [ ] **Step 2: Commit** `feat(cap-h): preload 暴露账本管理三 API`

### Task 4: 设置页账本管理卡

**Files:**
- Modify: `src/renderer/src/views/SettingsPage.tsx`

**Interfaces:**
- Consumes: Task 3 API、`getWorkspaceStatus`（current）、`basenamePath`（utils/path）、既有卡片结构

- [ ] **Step 1: recents 列表操作** —— 每项 `List.Item` 加 `Dropdown`（trigger 点击）：`打开`（当前项 disabled 显示 ✓；非当前走既有 `switchWorkspace`）/ `重命名`（`Modal` + `Input` 默认填 basename → 调 `renameWorkspace`，成功后 `window.location.reload()`）/ `归档`（`Modal.confirm` 说明移动位置 → 成功后 reload）/ `删除`（仅非 current 显示；`Modal.confirm` 要求**输入目录名完全一致**才启用确定按钮 → 成功后刷新列表）
- [ ] **Step 2: 当前账本标识** —— current 项加 `Tag color="processing">当前</Tag>`；归档/删除当前项时相应项禁用并 Tooltip 说明
- [ ] **Step 3: 操作后刷新** —— 列表状态本地 `useState`，三个操作成功后重拉 `getWorkspaceRecents` + `getWorkspaceStatus`
- [ ] **Step 4: 验证**：typecheck + unit；`npm run dev` 手动全链路（在测试目录建临时账本演练重命名/归档/删除，**勿动真实账本**）
- [ ] **Step 5: Commit** `feat(cap-h): 设置页账本管理卡（打开/重命名/归档/删除）`

### Task 5: 批次收尾

- [ ] **Step 1:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿（与并行批次错峰跑 e2e）
- [ ] **Step 2:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree
