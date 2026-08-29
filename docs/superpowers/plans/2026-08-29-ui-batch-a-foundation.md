# 批次 A：UI 地基（路由化 + ProLayout + Token/Less 体系）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 HashRouter + ProLayout 重写应用壳，建立 antd Token 与 Less 样式地基，消除整页滚动与视图常驻挂载。

**Architecture:** `App.tsx` 从 useState+display:none 改为 HashRouter 路由表 + ProLayout 框架；新增 `theme/tokens.ts`（antd token 单源）与 `styles/` Less 分层；主内容区独立滚动 + 纯 CSS 页面切换动画。所有后续批次消费本批产物（见总计划「接口契约」）。

**Tech Stack:** React 19 + antd 5.29 + ProLayout（@ant-design/pro-components 已有）+ react-router-dom（本批新增）+ less（devDep 本批新增）。

**Spec:** `ui-optimization-plan.md`（第二、三节 + 模块 1、9）、`docs/superpowers/plans/2026-08-29-ui-optimization-master.md`（全局约束 + 契约）、`CLAUDE.md`。

**Worktree:** `.worktrees/a-foundation`，分支 `ui-v4/a-foundation`，基于 `ui-v4`。

## Global Constraints

见总计划「Global Constraints」一节，逐条适用。

---

### Task 1: 依赖与 Less 脚手架

**Files:**
- Modify: `package.json`（dependencies + react-router-dom；devDependencies + less）
- Create: `src/renderer/src/styles/tokens.less`
- Create: `src/renderer/src/styles/base.less`
- Create: `src/renderer/src/styles/layout.less`
- Modify: `src/renderer/src/main.tsx`（import 新 less）

**Interfaces:**
- Produces: `tokens.less` 中变量 `@bw-primary: #1d39c4; @bw-inflow: #08979c; @bw-outflow: #d46b08; @bw-negative: #cf1322; @bw-bg-layout: #f5f7fa; @bw-text-base: #0f172a;` 及同名 `--bw-*` CSS 变量；`base.less` 提供 `.num` 类；`layout.less` 提供 `.page-scroll` / `.page-enter`

- [ ] **Step 1: 安装依赖**

```bash
npm i react-router-dom && npm i -D less
```

- [ ] **Step 2: 写 tokens.less**（文件头注释注明与 `theme/tokens.ts` 同步）

```less
// 与 src/renderer/src/theme/tokens.ts 的 BW_COLORS 保持同步（修改任一侧必须同步另一侧）
@bw-primary: #1d39c4;
@bw-inflow: #08979c;
@bw-outflow: #d46b08;
@bw-negative: #cf1322;
@bw-bg-layout: #f5f7fa;
@bw-text-base: #0f172a;

:root {
  --bw-primary: @bw-primary;
  --bw-inflow: @bw-inflow;
  --bw-outflow: @bw-outflow;
  --bw-negative: @bw-negative;
  --bw-bg-layout: @bw-bg-layout;
  --bw-text-base: @bw-text-base;
}
```

- [ ] **Step 3: 写 base.less**（沿用方案 2.3 节内容：字体栈、`.num`、`.num-negative`）

- [ ] **Step 4: 写 layout.less**（沿用方案第三节代码：`.page-scroll` 高度 `calc(100vh - 56px)` + overflow-y、`.page-enter` 180ms 动画、`prefers-reduced-motion` 覆写）

- [ ] **Step 5: main.tsx 引入**（在 `import './styles.css'` 处替换为 `import './styles/tokens.less'; import './styles/base.less'; import './styles/layout.less';`，删除 `styles.css`）

- [ ] **Step 6: 验证构建**：`npm run typecheck` 通过；`npm run build` 通过（electron-vite 会用内置 less 管线编译，验证 less 可用）

- [ ] **Step 7: Commit** `feat(ui-a): less 样式脚手架 + react-router-dom/less 依赖`

### Task 2: antd Theme Token 单源

**Files:**
- Create: `src/renderer/src/theme/tokens.ts`
- Modify: `src/renderer/src/main.tsx`（ConfigProvider theme）
- Test: `src/renderer/src/theme/tokens.test.ts`

**Interfaces:**
- Produces: `BW_COLORS`（值见总计划契约）、`THEME_TOKENS: ThemeConfig`（含 `token: { colorPrimary, colorSuccess, colorWarning, colorError, colorInfo, colorTextBase, colorBgLayout, borderRadius: 6, fontSize: 14, wireframe: false }`）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { BW_COLORS, THEME_TOKENS } from './tokens'

describe('THEME_TOKENS', () => {
  it('与契约色值一致', () => {
    expect(BW_COLORS.primary).toBe('#1d39c4')
    expect(BW_COLORS.negative).toBe('#cf1322')
    expect(THEME_TOKENS.token?.colorPrimary).toBe(BW_COLORS.primary)
    expect(THEME_TOKENS.token?.borderRadius).toBe(6)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/renderer/src/theme/tokens.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现 tokens.ts**（按 Interfaces 值实现；`import type { ThemeConfig } from 'antd'`）
- [ ] **Step 4: 跑测试通过** 同上命令 → PASS
- [ ] **Step 5: main.tsx 挂主题**：`<ConfigProvider locale={zhCN} theme={THEME_TOKENS}>`
- [ ] **Step 6: Commit** `feat(ui-a): antd design token 单源 + ConfigProvider 接入`

### Task 3: App.tsx 重写（HashRouter + ProLayout + 滚动/动画/兜底）

**Files:**
- Modify: `src/renderer/src/App.tsx`（整文件重写）
- Create: `src/renderer/src/views/HeaderStatusArea.tsx`
- Create: `src/renderer/src/views/LedgerSwitcher.tsx`（基础版）
- Create: `src/renderer/src/views/DashboardPlaceholder.tsx`、`src/renderer/src/views/SettingsPage.tsx`（占位，卡片骨架 + `Empty`「批次 D 完善」）
- Test: `e2e/smoke.spec.ts`（更新断言）

**Interfaces:**
- Consumes: Task 1/2 的 less 类与 THEME_TOKENS；既有 `WorkspaceSwitcher` 的打开目录链路（`chooseWorkspaceFolder` + `openWorkspace` + `window.location.reload()`，迁移进 LedgerSwitcher）
- Produces: 路由表（总计划契约）；`LedgerSwitcher`（批次 C 增强）；菜单标签 `录入/明细/报表/编辑器/合并(条件)/总览/设置`

- [ ] **Step 1: LedgerSwitcher 基础版** —— Button(type text, size large) 显示当前目录 `basename`（临时内联 `path.split(/[\\/]/).pop()`，批次 C 抽 util）+ Dropdown（当前项 disabled + `浏览其他目录…` 走原 WorkspaceSwitcher 链路）；hover Tooltip 显示完整路径
- [ ] **Step 2: HeaderStatusArea** —— 按方案模块 1 代码骨架：同步状态 `Popover`（内含分支 Tag / 上次同步 / 拉取按钮 / 冲突入口 / 同步设置 / 索引状态 Tag + 重建索引，内容取自现 `SyncStatusBar` + `App.tsx:144-161` 的元素，**SyncStatusBar.tsx 保留不删**，Popover 内容复用其元素）、更新按钮加 `Badge dot`（`useUpdateStore` 有可用更新时）、AI 徽标（configured 与否，点击开 `AiSettingsModal`）
- [ ] **Step 3: 占位页** —— `DashboardPlaceholder`：`Result icon={<DashboardOutlined>} title="总览" subTitle="批次 D 落地指标卡与图表" />`；`SettingsPage`：分区骨架（账本管理/同步/AI/索引/关于，各放 `Empty` 占位）
- [ ] **Step 4: 重写 App.tsx** —— 按方案第三节 ≤30 行骨架落地，要点：
  - `HashRouter` + `Routes`（`/`=DashboardPlaceholder，`/entry`=EntryFormView，`/entries`=EntriesView，`/reports`=ReportsView，`/editor`=EditorView，`/merge`=ConflictView，`/settings`=SettingsPage，`*`→`<Navigate to="/" replace />`）
  - ProLayout：`route={{ routes: MENU }}`（`/` 总览 DashboardOutlined、`/entry` 录入 FormOutlined、`/entries` 明细 UnorderedListOutlined、`/reports` 报表 BarChartOutlined、`/editor` 编辑器 FileTextOutlined、`/merge` 合并 CloudOutlined 仅 `conflict` 时），`menuItemRender` 用 `Link`，`avatarProps` → 设置入口，`headerContentRender` → `<LedgerSwitcher />`，右侧状态区由 `HeaderStatusArea` 通过 `headerRender`/页面级 Layout 组合（若 ProLayout 插槽不顺，可 ProLayout 外层不再套 Header，状态区放 `headerContentRender` 右侧 flex）
  - 保留：workspace 加载门控逻辑（`ready` 前 `Content` 区域渲染 `Skeleton` 而非 `null`）、`workspaceError` → `<Result status="error" extra={[重试/更换目录]}>`、`conflict` 条件菜单项、各 Modal（Sync/Ai/Update）
  - 删除：`display:none` 挂载、`calc(100vh - 112px)`、Sider 磁盘路径展示、重复 appName 标题
  - 滚动复位：`contentRef` + `useEffect(..., [location.pathname])`
- [ ] **Step 5: 更新 e2e/smoke.spec.ts** —— 默认路由改为总览：`await expect(win.getByText('总览')).toBeVisible()`；再 `win.getByRole('menuitem', { name: '录入' }).click()` 后断言 `写入账本` 按钮可见（保住 preload 链路断言）
- [ ] **Step 6: 验证**：`npm run typecheck`；`npm run test:unit`；`npm run test:e2e`（smoke/ledger-index/reports/editor/sync/ai-entry/update 全绿；ledger-index 的 `menuitem '明细'` 点击依赖平铺菜单 —— 已保持）
- [ ] **Step 7: Commit** `feat(ui-a): HashRouter + ProLayout 应用壳重写（内容区独立滚动 + 路由动画 + 失败兜底）`

### Task 4: 窗口默认尺寸

**Files:**
- Modify: `src/main/index.ts:29-33`

- [ ] **Step 1:** `{ width: 1440, height: 900, minWidth: 1280, minHeight: 800, useContentSize: true }`
- [ ] **Step 2: 验证**：`npm run test:e2e`（smoke 启动断言仍过）
- [ ] **Step 3: Commit** `feat(ui-a): 窗口默认 1440×900，最小 1280×800`

### Task 5: 批次收尾

- [ ] **Step 1:** 全量 `npm run typecheck && npm run test:unit && npm run test:e2e` 全绿
- [ ] **Step 2:** 勾选本文件 checkbox，`git add -A && git commit`（如有遗漏）
- [ ] **Step 3:** 按总计划 DoD 合并回 `ui-v4` 并移除 worktree
