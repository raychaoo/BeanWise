# BeanWise UI 优化 · 总计划与 Worktree 分批

> **For agentic workers:** 本文件是分批总控文档。每个批次（worktree）由**独立新会话**执行对应批次计划 `2026-08-29-ui-batch-{a..e}-*.md`，REQUIRED SUB-SKILL: superpowers:executing-plans。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 按 `ui-optimization-plan.md`（下称「方案」）完成 BeanWise UI 全面改造，分 5 个 worktree 批次串行落地。

**Architecture:** 批次 A 打地基（路由化 + ProLayout + Token/Less 体系），B/C/D/E 在其上并行不可能（共享 App.tsx 等），故**严格串行**：A → B → C → D → E，每批完成即合回 `ui-v4`，下一批从新 `ui-v4` 开 worktree。

**Tech Stack:** Electron + electron-vite + React 19 + antd 5.29 + ProComponents 2.8.10 + Zustand 5 + Less（新增 devDep）+ react-router-dom（唯一新增 runtime 依赖，HashRouter）。

**Spec:** `ui-optimization-plan.md`（设计决策与代码骨架）、`ui-plan.md`（需求书与硬性红线）、`CLAUDE.md`（项目约束）。执行者三份都要读。

## Global Constraints（每个批次隐含遵守）

- 仅新增 runtime 依赖 `react-router-dom`（HashRouter）；`less` 仅为 devDependency（Vite 内置支持，零配置）
- 路由切换动画纯 CSS（180ms fade+translateY），`prefers-reduced-motion` 下禁用；仅主内容区参与动画
- 主内容区唯一滚动容器；Header/Sider 固定不随滚动
- 金额一律十进制字符串：录入 `stringMode` 不动；任何前端聚合用 `addDecimalStrings`（`src/shared/decimal.ts`），禁 `Number`/`parseFloat`/SQL SUM
- 写路径唯一：录入仍走 ProForm → `ledger:add-entry`；Excel/AI 面板仅换容器（Drawer），逻辑零改动
- 不修改已有 API / DB 结构 / 业务逻辑 / 不删功能；新增 IPC 按标准链路：`src/shared/ipc.ts` 类型 → preload 白名单 → main handler
- CSP 禁 remote 字体与 CDN；生产 `style-src 'unsafe-inline'` 已放行（index.html 内联 Splash 样式可用）
- antd 锁 5.x（禁 v6）；`@ant-design/v5-patch-for-react-19` 必须是 main.tsx 第一行 import
- E2E 依赖的菜单文本 `录入` / `明细` / `报表` **不得改名**（`e2e/ledger-index.spec.ts`、`e2e/reports.spec.ts` 依赖）
- 每任务先测后码（纯函数 Vitest TDD；视图层 typecheck + e2e 回归），小步提交
- 测试账本目录：`F:\BeanWiseData\test`；VS Code 集成终端先 `env -u ELECTRON_RUN_AS_NODE` 再跑 dev/E2E

## 批次总览与合并顺序

| 批次 | 分支 | Worktree 路径 | 范围 | 依赖 | 计划文件 |
|---|---|---|---|---|---|
| A | `ui-v4/a-foundation` | `.worktrees/a-foundation` | 路由化 + ProLayout 框架 + Token/Less 地基 + 窗口尺寸 | 无（基于 ui-v4 HEAD） | `2026-08-29-ui-batch-a-foundation.md` |
| B | `ui-v4/b-transaction` | `.worktrees/b-transaction` | 交易域：录入双栏重排 + Excel/AI 抽屉化 + 流水页瘦身 | A | `2026-08-29-ui-batch-b-transaction.md` |
| C | `ui-v4/c-workspace` | `.worktrees/c-workspace` | 账本切换（recents 全链路 + Dropdown + Ctrl+K）| A（建议在 B 后） | `2026-08-29-ui-batch-c-workspace.md` |
| D | `ui-v4/d-new-pages` | `.worktrees/d-new-pages` | 新页面：总览 Dashboard + 对账 + 账户 + 设置 | A、B、C | `2026-08-29-ui-batch-d-pages.md` |
| E | `ui-v4/e-coldstart-reports` | `.worktrees/e-coldstart-reports` | 冷启动 Splash + 报表排版（账户式/报告式）+ 收尾 | A、D | `2026-08-29-ui-batch-e-coldstart-reports.md` |

**串行理由**：五批共享 `App.tsx`/`main.tsx`/`package.json`，并行 worktree 必产生冲突；B、C 理论上可在 A 后并行，但两者都改 App.tsx（B 改路由内容区、C 改 Header），串行成本更低。

## 批次间接口契约（后续批次依赖的产物）

批次 A 产出（B/C/D/E 全部消费）：
- `src/renderer/src/theme/tokens.ts`：`export const BW_COLORS = { primary: '#1d39c4', inflow: '#08979c', outflow: '#d46b08', negative: '#cf1322', bgLayout: '#f5f7fa', textBase: '#0f172a' }` 与 `export const THEME_TOKENS: ThemeConfig`（antd token 对象）
- Less 脚手架：`src/renderer/src/styles/tokens.less`（`--bw-*` CSS 变量 + `@bw-*` less 变量）、`base.less`（`.num` 金额类）、`layout.less`（`.page-scroll` / `.page-enter` / reduced-motion）
- 路由表：`/`（总览占位）`/entry` `/entries` `/reports` `/editor` `/merge` `/settings`（设置占位），`*` → `/`
- `App.tsx` 结构：HashRouter + ProLayout + `.page-scroll` 滚动容器 + scroll 复位 + `workspaceError` → `Result` 兜底
- 菜单：一级平铺 `总览 / 录入 / 明细 / 报表 / 编辑器`（+冲突时 `合并`），底部 `设置`；标签 `录入`/`明细`/`报表` 保持不变
- `src/renderer/src/views/LedgerSwitcher.tsx`：基础版（当前账本名 + 浏览其他目录），批次 C 增强
- 窗口 1440×900 / min 1280×800（`src/main/index.ts`）

批次 B 产出（D 消费）：`SettingsPage` 中已迁入「索引状态卡 + 清空账本」区块；`formatAmount`（`src/renderer/src/utils/format.ts`）；录入页 dirty 无外部状态（C 自建）。

批次 C 产出（D 消费）：`getWorkspaceRecents()` preload API 可用；`basenamePath`（`src/renderer/src/utils/path.ts`）。

## 每批次完成标准（DoD）

1. `npm run typecheck` 0 错误
2. `npm run test:unit` 全绿
3. `npm run test:e2e` 全绿（测试账本 `F:\BeanWiseData\test`）
4. 该批次计划文件所有 checkbox 勾选
5. 合并回 `ui-v4`：`git checkout ui-v4 && git merge --no-ff ui-v4/<batch>`，然后 `git worktree remove .worktrees/<dir>`
6. 下一批次会话从更新后的 `ui-v4` 创建新 worktree（命令见批次计划开头）

## 各批次新会话提示词

见仓库根目录 `worktree-session-prompts.md`（与本文件同步维护，内容一致）。
