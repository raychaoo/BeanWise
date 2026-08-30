# BeanWise 能力扩展 · Worktree 批次会话提示词（2026-08-30）

> 用法：在 ZCode 中**新开会话**，把对应批次的提示词整段粘贴为第一条消息即可。
> 节奏：**F / H / I 三个会话同时开工**（文件所有权互不相交，各自完成各自合并）→ 三批全部合并后 **G 收口**。

---

## 波次 1 · 批次 F：明细账账户过滤（与 H/I 同时开工）

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-30-cap-f-entry-account-filter.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-30-capability-batches-master.md —— 全局约束、接口契约、并行规则
3. ui-optimization-plan.md —— 背景（第七节超 UI 层清单，你负责 #2 的账户过滤收尾）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）能力扩展批次 F。前轮 UI 改造（批次 A-E）已全部合并进 ui-v4。本批与批次 H、I 同时在各自 worktree 并行。

并行纪律（违反即冲突）：本批独占 src/main/index-builder.ts（listEntries 查询）与 src/renderer/src/views/ReconcilePage.tsx；不得改动 shared/ipc.ts、preload/*、shared/api.ts、package.json、其他页面。ListEntriesParams 类型定义在 index-builder.ts 并经 shared/ipc.ts 转出，加字段不需要动 preload。

硬性红线（违反即返工）：零新增依赖；金额展示 formatAmount + .num 类，禁 Number/parseFloat；account 过滤为精确匹配（不做前缀展开），入参校验 + SQL 参数化；对账页 Tab①（科目余额表）归批次 G，本批不得改动 Tab①；删除 Tab② 的占位 Empty。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。完成后先 git merge ui-v4 吸收并行批次已合并内容，再跑 npm run typecheck && npm run test:unit && npm run test:e2e（不要与并行会话同时跑全量 e2e，smoke 错峰；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后在主 checkout 执行 git merge --no-ff ui/f-entry-account-filter 合并回 ui-v4 并 git worktree remove .worktrees/f-entry-account-filter。
```

---

## 波次 1 · 批次 H：账本管理（与 F/I 同时开工）

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-30-cap-h-workspace-mgmt.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-30-capability-batches-master.md —— 全局约束、接口契约、并行规则
3. ui-optimization-plan.md —— 背景（模块 8 账本管理，你负责清单 #3）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）能力扩展批次 H。前轮 UI 改造（批次 A-E）已全部合并进 ui-v4：设置页账本管理卡已有 recents 列表与打开（switchWorkspace）。本批与批次 F、I 同时在各自 worktree 并行。

并行纪律（违反即冲突）：本批独占 src/main/workspace-store.ts、src/main/ipc-handlers-workspace.ts、src/shared/ipc.ts（workspace 段）、src/preload/index.ts、src/shared/api.ts、src/renderer/src/views/SettingsPage.tsx；不得改动 index-builder.ts、ReconcilePage.tsx、AccountsPage.tsx、stores/ledger.ts、App.tsx、package.json。注意 shared/ipc.ts 只加 workspace 通道与类型，AccountEntry 段归批次 I（并行中），编辑时不要触碰该区域。

硬性红线（违反即返工）：零新增依赖；三个新 handler 全部走白名单校验（只允许 current/recents 已登记路径）；删除通道拒绝当前账本；重命名/归档/删除均需 UI 二次确认（删除需输入目录名确认）；不改动既有四通道行为；归档移动到 <parent>/.beanwise-archive/。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。完成后先 git merge ui-v4 吸收并行批次已合并内容，再跑 npm run typecheck && npm run test:unit && npm run test:e2e（不要与并行会话同时跑全量 e2e，smoke 错峰；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后在主 checkout 执行 git merge --no-ff ui/h-workspace-mgmt 合并回 ui-v4 并 git worktree remove .worktrees/h-workspace-mgmt。
```

---

## 波次 1 · 批次 I：科目期初余额 + 启停用（与 F/H 同时开工）

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-30-cap-i-account-config.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-30-capability-batches-master.md —— 全局约束、接口契约、并行规则
3. ui-optimization-plan.md —— 背景（模块 4 账户管理，你负责清单 #6）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）能力扩展批次 I。前轮 UI 改造（批次 A-E）已全部合并进 ui-v4：账户页 AccountsPage 已有分类 Tabs + 编辑表 + Drawer 新增。本批与批次 F、H 同时在各自 worktree 并行。

并行纪律（违反即冲突）：本批独占 src/shared/ipc.ts（仅 AccountEntry 接口段——IpcChannel 通道行归批次 H，并行中，不要触碰该行）、src/renderer/src/stores/ledger.ts（mergeAccountOptions）、src/renderer/src/views/AccountsPage.tsx、src/main/account-config-store.ts；不得改动 preload/*、shared/api.ts、index-builder.ts、SettingsPage.tsx、EntryFormView.tsx、package.json。

硬性红线（违反即返工）：零新增依赖；期初余额不存配置文件、不引入第二写路径——组合 AddEntryParams 后走既有 addLedgerEntry 通道落账本（Equity:Opening-Balances 配对）；金额全链路十进制字符串（禁 Number/parseFloat）；启停用是纯配置字段，过滤发生在渲染端 mergeAccountOptions（语义边界：只有账户库配置条目可停用）；保存模型保持「显式保存」，启停用切换不即时写盘。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。Task 4 Step 3 需实测 add-entry 对未 open 账户的行为并把结论记录在 checkbox 旁。完成后先 git merge ui-v4 吸收并行批次已合并内容，再跑 npm run typecheck && npm run test:unit && npm run test:e2e（不要与并行会话同时跑全量 e2e，smoke 错峰；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后在主 checkout 执行 git merge --no-ff ui/i-account-config 合并回 ui-v4 并 git worktree remove .worktrees/i-account-config。
```

---

## 波次 2 · 批次 G：报表域扩展（等 F/H/I 全部合并后再开工）

```
请先阅读以下三个文件再动手（都在本仓库内）：
1. docs/superpowers/plans/2026-08-30-cap-g-reports-plus.md —— 你的执行计划（文件开头有前置命令，先执行它创建本批次 worktree）
2. docs/superpowers/plans/2026-08-30-capability-batches-master.md —— 全局约束、接口契约、并行规则
3. ui-optimization-plan.md —— 背景（模块 2/5/6，你负责清单 #4、#5、#7、#8）

背景：BeanWise（Beancount 复式记账 Electron 应用，React 19 + antd 5.29 + electron-vite）能力扩展批次 G（收口批）。批次 F/H/I 已全部合并进 ui-v4：明细账账户过滤（F）、账本管理通道（H）、AccountEntry.enabled 与期初余额（I）已就绪——全部不要动。报表聚合代码在 src/main/report-aggregation.ts（纯函数 + 单测齐全）与 src/main/ipc-handlers-report.ts（IPC 接线），先通读再动手。

硬性红线（违反即返工）：零新增依赖；所有新聚合先写纯函数单测再接 IPC，金额累加 addDecimalStrings、禁 SQL SUM/Number；reports.spec.ts 依赖的默认 Tab 卡片标题（净资产趋势/收支对比/账户余额）与起始年/结束年 Select 不得动；现金流量表口径 = Assets 顶层组全部账户视为资金池（口径假设写进实现注释与 UI 说明，池内互转不计）；PDF 用 webContents.printToPDF + dialog.showSaveDialog + @media print 打印隔离（隐藏侧栏/Header/工具栏，.page-scroll 高度 auto）；三通道（report:trial-balance / report:cash-flow / report:export-pdf）按标准链路 shared/ipc.ts → preload → shared/api.ts → main handler。

执行方式：使用 executing-plans 技能按任务顺序执行，每个任务：写测试→跑失败→实现→跑通过→commit。完成后运行 npm run typecheck && npm run test:unit && npm run test:e2e（spec 用独立临时账本；VS Code 终端先 env -u ELECTRON_RUN_AS_NODE），全绿后在主 checkout 执行 git merge --no-ff ui/g-reports-plus 合并回 ui-v4 并 git worktree remove .worktrees/g-reports-plus。本批是超 UI 层清单的最后一批：合并后在 CLAUDE.md 的 IPC 域表格补三通道说明。
```
