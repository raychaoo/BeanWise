# BeanWise UI 改造 · Worktree 批次会话提示词

> 用法：在 ZCode 中**新开会话**，把对应批次的提示词整段粘贴为第一条消息即可。批次必须按 A → B → C → D → E 顺序执行（后批基于前批合并后的 ui-v4）。

---

## 批次 A（无需前置，worktree 已创建于 `.worktrees/a-foundation`）

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-29-ui-batch-a-foundation.md —— 你的执行计划（逐任务逐步骤勾选执行）
2. docs/superpowers/plans/2026-08-29-ui-optimization-master.md —— 全局约束与批次间接口契约
3. ui-optimization-plan.md —— 设计方案（本批重点：第二节视觉规范、第三节路由表、模块 1、模块 9）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）UI 改造批次 A。当前 worktree 已建好、npm install 已完成、typecheck 与单测基线通过。

硬性红线（违反即返工）：仅新增 runtime 依赖 react-router-dom（HashRouter）；e2e 依赖的菜单文本「录入/明细/报表」不得改名；录入写路径与金额 stringMode 链路逻辑零改动；@ant-design/v5-patch-for-react-19 保持 main.tsx 第一行 import；路由切换动画纯 CSS 且尊重 prefers-reduced-motion；主内容区唯一滚动容器。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。全部完成后运行 npm run typecheck && npm run test:unit && npm run test:e2e（测试账本 F:\BeanWiseData\test；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后按 master 计划 DoD 将 ui-v4/a-foundation 以 --no-ff 合并回 ui-v4 并 git worktree remove .worktrees/a-foundation。
```

---

## 批次 B

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-29-ui-batch-b-transaction.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-29-ui-optimization-master.md —— 全局约束与批次间接口契约（重点：批次 A 产物，你直接消费）
3. ui-optimization-plan.md —— 设计方案（本批重点：模块 3 交易页）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）UI 改造批次 B。批次 A（路由化 + ProLayout + Token/Less 地基）已合并进 ui-v4：路由 /entry /entries /settings 已存在，theme/tokens.ts、styles/ 脚手架、.num 类已就绪。

硬性红线（违反即返工）：录入写路径（ProForm → add-entry、nextBalancingNumber 自动平衡、stringMode）逻辑零改动；e2e 表单 label「交易对象/说明/账户/金额/货币」与按钮「写入账本」文本不得改；明细页必须保留「重建索引」按钮（e2e 依赖）；零新增依赖；样式写进 styles/views/*.less 不用内联 style。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。全部完成后运行 npm run typecheck && npm run test:unit && npm run test:e2e（测试账本 F:\BeanWiseData\test；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后按 master 计划 DoD 将 ui-v4/b-transaction 以 --no-ff 合并回 ui-v4 并 git worktree remove .worktrees/b-transaction。
```

---

## 批次 C

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-29-ui-batch-c-workspace.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-29-ui-optimization-master.md —— 全局约束与批次间接口契约
3. ui-optimization-plan.md —— 设计方案（本批重点：模块 8 账本切换）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）UI 改造批次 C。批次 A/B 已合并进 ui-v4。注意：主进程 workspace-store 的 loadRecents() 已存在、IpcChannel 类型已有 'workspace:recents'，但 main 的 handler 注册、shared/api.ts 类型、preload 白名单三处都缺失，需按 IPC 标准链路补全（计划 Task 1）。

硬性红线（违反即返工）：切换成功后仍走 window.location.reload()（不做软切换）；不改动任何已有 IPC handler；零新增依赖；脏表单确认仅提示不阻断浏览目录链路。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。全部完成后运行 npm run typecheck && npm run test:unit && npm run test:e2e（测试账本 F:\BeanWiseData\test；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后按 master 计划 DoD 将 ui-v4/c-workspace 以 --no-ff 合并回 ui-v4 并 git worktree remove .worktrees/c-workspace。
```

---

## 批次 D

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-29-ui-batch-d-pages.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-29-ui-optimization-master.md —— 全局约束与批次间接口契约
3. ui-optimization-plan.md —— 设计方案（本批重点：模块 2 总览、模块 4 账户、模块 5 对账、设置页）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）UI 改造批次 D。批次 A/B/C 已合并进 ui-v4：/settings 已有索引状态与清空账本区块（批次 B 迁入），getWorkspaceRecents 与 switchWorkspace 可用（批次 C），.num/formatAmount/TimeRange 类基建就绪。

硬性红线（违反即返工）：指标聚合一律 addDecimalStrings（禁 Number/parseFloat/SQL SUM），图表 y 值 Number() 仅显示层；/reports 现有卡片标题（净资产趋势/收支对比/账户余额）与起始年/结束年 Select 不得动（e2e 依赖）；AccountSettingsModal 逻辑原样搬移不重写；零新增依赖。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。全部完成后运行 npm run typecheck && npm run test:unit && npm run test:e2e（测试账本 F:\BeanWiseData\test；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后按 master 计划 DoD 将 ui-v4/d-new-pages 以 --no-ff 合并回 ui-v4 并 git worktree remove .worktrees/d-new-pages。
```

---

## 批次 E

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-29-ui-batch-e-coldstart-reports.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-29-ui-optimization-master.md —— 全局约束与批次间接口契约
3. ui-optimization-plan.md —— 设计方案（本批重点：模块 9 冷启动、模块 6 报表）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）UI 改造批次 E（最后一批）。批次 A-D 已合并进 ui-v4：全部页面与路由就绪。

硬性红线（违反即返工）：Splash 是 index.html 内联纯 CSS，禁止任何 <script>（CSP script-src 严格）；报表默认 Tab 的卡片标题与结构不得动（e2e 依赖）；资产负债表合计校验用 addDecimalStrings/computeBalancingNumber；零新增依赖。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。全部完成后运行 npm run typecheck && npm run test:unit && npm run test:e2e（测试账本 F:\BeanWiseData\test；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后按 master 计划 DoD 将 ui-v4/e-coldstart-reports 以 --no-ff 合并回 ui-v4 并 git worktree remove .worktrees/e-coldstart-reports；最后在本仓库根目录执行 git worktree prune，并确认五批分支是否保留由用户决定。
```
