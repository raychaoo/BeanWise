# 关键设计决策记录（ADR 风格）

| # | 决策 | 原方案 | 优化后 | 理由 |
|---|---|---|---|---|
| 1 | 密钥存储 | keytar | **Electron safeStorage** | keytar 已停止维护；safeStorage 零依赖、基于系统钥匙串 |
| 2 | Python 分发 | 未定义 | **PyInstaller 独立二进制** | 用户无需安装 Python，安装包自包含 |
| 3 | Node↔Python 通信 | 未定义 | **stdio JSON-RPC (JSONL)** | 无端口冲突、生命周期绑定、可优雅退出 |
| 4 | Beancount 版本 | 未约束 | **锁定 v3** | v2/v3 语法与 API 差异大，避免兼容性灾难 |
| 5 | CI/CD | 无 | **GitHub Actions Windows 单平台构建** | 与 GitHub 仓库、electron-updater 形成闭环 |
| 6 | E2E 测试 | 仅单测 | **补 Playwright** | 录入→校验→同步链路单测覆盖不到 |
| 7 | 签名 | 无 | **electron-builder Authenticode 代码签名** | 自动更新的硬性前置条件 |
| 8 | Monaco | 仅架构图提及 | **正式纳入技术栈（M5 落地）** | 承担编辑、beancount 语法高亮、git diff 三职责；M5 定稿：裸 monaco-editor（0.56）+ Vite `?worker` 本地打包 worker（`monaco-editor/editor/editor.worker?worker`——0.56 exports map 下带 `esm/vs` 前缀会双写报错）、自研 monarch beancount 语言、生产 CSP 补 `worker-src 'self'`；编辑器保存走整文件覆盖（tmp 校验 + rename 原子替换，校验失败不落盘） |
| 9 | git 冲突 UX | 未定义 | **自研三路合并 UI（基于 Monaco 双向 DiffEditor 组合）** | 否则同步功能体验断裂；Monaco 无内置三路合并器（VS Code 合并编辑器为闭源，不在 Monaco 中）。**M6 落地（2026-08-10）**：布局 = 上双 DiffEditor（base vs ours / base vs theirs）+ 下 merged 可编辑；冲突三路快照（base/ours/theirs）经 IPC 内存传递，不写冲突标记文件；merged 内容走「tmp 校验 + rename」管线（`writeLedgerChecked`），校验失败不落盘；resolve 成功 → 双亲合并提交 → push → refreshIndex |
| 10 | 安全边界 | 未定义 | **CSP + Key 只存主进程** | Token / API Key 不落渲染进程 |
| 11 | git 同步引擎 | AutoGit v2.2 + libgit2 | **isomorphic-git** | 原方案在 npm 查无此库；唯一 libgit2 绑定 nodegit 已停维护且 Windows 本地编译困难；isomorphic-git 纯 JS 零原生依赖，Electron 内免编译。**M6 落地（2026-08-10）**：1.41.3 实测——仅 http/https 传输（file:// 本地传输已在 1.x 移除，测试/E2E 用进程内 smart-HTTP 服务器 `src/main/git-test-server.ts` 替代）；封装 GitSync 薄层（init/commit/fetch/analyzeMerge/mergeFile diff3 合并，`git.mergeFile` 在 1.x 未导出故用同款 diff3 算法本地实现）；合并提交为双亲提交（parents=[HEAD, 远端]），保证 push 客户端快进检查通过 |
| 12 | AI 结构化输出 | response_format JSON Schema | **Function Calling + 主进程按 schema 校验** | V4 API 已宣称支持 `json_schema`（deepseek-go SDK 已对齐），但 Agno / LangChain 实测 deepseek-v4-flash 仍报 400，支持状态不稳定；`json_object` 模式要求 prompt 含 "json" 且不保证 schema 合规；Function Calling（v4-flash 支持，reasoner 不支持）的 tool schema 即结构约束，输出仍须客户端校验 |
| 13 | AI 请求通道 | 二选一（主进程代理 / Python 转发） | **主进程代理** | 延续既有安全边界（Key 不落渲染进程）；Python 转发多一跳且需把 Key 传入子进程 |

## 待评审 / 待定事项

- [ ] 大账本（>5 万笔）性能基准：增量解析策略是否足够
- [ ] 是否兼容 Fava 报表格式