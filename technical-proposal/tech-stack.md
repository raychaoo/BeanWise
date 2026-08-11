# 技术栈清单

## 桌面框架

| 技术 | 说明 | 版本约束 |
|---|---|---|
| Electron | 主进程 / Preload / 渲染进程三层架构 | 最新稳定版 |
| Vite | 渲染进程构建 | — |
| React + TypeScript | 严格模式 | — |

## 数据与存储

| 技术 | 说明 | 版本约束 |
|---|---|---|
| Beancount | 账本文件为**唯一事实源**；SQLite 仅为索引缓存 | **锁定 v3**（v2/v3 语法与 API 差异大，禁止混用）；v3 已拆分，query 引擎为独立包 **beanquery**，需一并打包 |
| Python 3.11 | Beancount 引擎运行环境 | — |
| PyInstaller | 将 Python 引擎打包为独立二进制，随 Electron 分发（`extraResources`） | 推荐 `--collect-all beancount`（动态导入多）+ 显式收集 `beanquery`（v3 拆包）；`--onefile` 启动有解压延迟，引擎常驻可接受 |
| stdio JSON-RPC | Node ↔ Python 通信协议，JSONL 逐行 | 无端口冲突，生命周期随主进程 |
| better-sqlite3 + Drizzle ORM | SQLite 索引层 | 原生模块；13.x 自带 in-tarball N-API prebuild，`asarUnpack` + `npmRebuild: false` 即可（M3 实测，无需 electron-rebuild） |
| isomorphic-git | git 同步引擎（纯 JS 实现 git 协议，无原生依赖），对接 GitHub 私有仓库；M6 封装为 GitSync（账本目录即 git 工作区，只追踪账本文件，分支固定 main）；合并提交双亲语义（[HEAD, 远端]） | 1.41.3（仅 http/https 传输，**不支持 file:// 本地传输**——测试/E2E 用进程内 smart-HTTP 服务器 `src/main/git-test-server.ts`）；替代已停维护的 libgit2 绑定（nodegit） |

## UI 层

| 技术 | 说明 |
|---|---|
| Ant Design + ProComponents | ProForm 承载 Beancount 录入表单 |
| Ant Design Charts | 数据可视化图表 |
| Monaco Editor | 账本编辑 + git 冲突合并 UI（双向 DiffEditor 组合）；M5 定稿：裸 monaco-editor（0.56），worker 经 Vite `?worker` 本地打包（`monaco-editor/editor/editor.worker?worker`），自研 monarch beancount 语法高亮，CSS 经相对路径直入 node_modules |
| Zustand | 状态管理 |

## AI 辅助

| 技术 | 说明 |
|---|---|
| DeepSeek API（deepseek-v4-flash） | 自然语言 → Beancount 交易指令；Function Calling 定义交易结构 tool schema，主进程按 schema 校验输出（旧模型名 deepseek-chat / deepseek-reasoner 已于 2026-07 弃用） |
| 密钥管理 | API Key 本地化（safeStorage 加密），请求走主进程代理，Key 不落渲染进程 |

## 进程与通信

| 技术 | 说明 |
|---|---|
| Electron IPC + typed wrapper | `ipcMain.handle` / `ipcRenderer.invoke` + 共享类型契约 |
| Axios | HTTP 请求 |

## 安全

| 技术 | 说明 |
|---|---|
| Electron safeStorage | 密钥加密存储（替代已停止维护的 keytar） |
| CSP | 渲染进程禁远程资源加载，Token/Key 只存主进程 |

## 工程化

| 技术 | 说明 |
|---|---|
| electron-log | 日志 |
| electron-store | 配置管理（M6 起承载 git 同步配置 repoUrl/branch/adopted/lastSyncAt/lastError 与 PAT 密文——PAT 经 safeStorage 加密后 base64 存入，不落明文） |
| Vitest + pytest + Playwright | 前端单测 / Python 引擎测试 / Electron E2E |
| electron-builder | 打包 + Windows Authenticode 签名 |
| electron-updater | 自动更新，对接 GitHub Releases |
| GitHub Actions | Windows 单平台 CI/CD，tag 触发自动发布 |