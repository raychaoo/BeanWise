# CLAUDE.md

BeanWise（豆账）— Beancount 复式记
本文件为 Claude Code / AI 编程助手提供本仓库的项目上下文、常用命令与硬性约束。
请严格遵守，尤其是「关键约束」一节；不确定时先查阅本目录下的方案文档。

## 项目概览

Beancount 复式记账桌面应用（Electron 桌面端）。

- **核心原则**：Beancount 文件是唯一事实源（Single Source of Truth），SQLite 仅为索引缓存
- **能力**：账本录入（ProForm / Monaco / DeepSeek AI 辅助（deepseek-v4-flash））、校验、图表报表、GitHub 私有仓库同步
- **引擎**：Python 3.11 + Beancount v3，经 PyInstaller 打包为独立二进制随应用分发
- **同步**：isomorphic-git → GitHub 私有仓库（PAT 本地化，safeStorage 加密）

## 常用命令

```bash
npm run dev          # 启动 Vite dev + Electron
npm run typecheck    # TypeScript 严格模式检查
npm run test:unit    # Vitest 前端单测
npm run test:e2e     # Playwright Electron E2E（CI 无头环境需 xvfb-run -a）
npm run build:python # PyInstaller 打包 Python 引擎 → dist-python/
npm run dist:win     # electron-builder 构建 Windows 安装包（NSIS）
pytest python/tests  # Python Beancount 引擎测试
```

## 技术栈

- **桌面框架**：Electron · Vite · React + TypeScript（strict）
- **UI**：Ant Design + ProComponents（ProForm 录入）· Ant Charts · Monaco Editor · Zustand
- **数据**：better-sqlite3 + Drizzle ORM · electron-log · electron-store · Electron safeStorage
- **引擎**：Python 3.11 + Beancount v3 · PyInstaller · stdio JSON-RPC
- **工程化**：Vitest · pytest · Playwright · electron-builder · electron-updater · GitHub Actions

## 架构与进程边界

```
渲染进程(React) → Preload(contextBridge 白名单) → 主进程(IPC 路由)
                                                     ├─ PythonSvc（stdio JSON-RPC）
                                                     ├─ GitSync（isomorphic-git）
                                                     ├─ SQLite（Drizzle ORM）
                                                     └─ DeepSeek API 代理
```

- **Node ↔ Python 通信**：stdio JSON-RPC 2.0，JSONL 逐行（`\n` 分隔），方法：`ping` / `parse_file` / `validate` / `query` / `render_report` / `shutdown`（AI 解析走主进程代理，不经 Python）
- **Python 进程生命周期**：主进程 spawn 管理；异常退出按指数退避重启；`before-quit` 时优雅关闭
- **数据流**：录入/查询 Renderer → IPC → Main → Python Engine → SQLite 回填；文件变更 → 增量解析 → 重建索引

## 关键约束（违反即 bug）

1. **Beancount 文件是唯一事实源**：所有写入先落文件、校验通过后再重建 SQLite 索引；禁止绕过文件直接写 SQLite
2. **密钥隔离**：GitHub PAT / DeepSeek API Key 只在主进程持有（safeStorage 加密），渲染进程不可见；AI 请求必须走主进程代理
3. **渲染进程不直连 Python / SQLite / git**：一律走 IPC → 主进程
4. **Beancount 锁定 v3**：禁止引入 v2 语法 / API，两者差异大不可混用
5. **PyInstaller 输出目录固定为 `dist-python/`**（在 `python/service.spec` 配置 `distpath`），与 electron-builder 的 `dist/` 输出冲突会导致发布产物错误
6. **IPC 入参校验**：主进程对所有入参做类型与路径校验（防目录穿越），Preload 只暴露白名单 API
7. **原生模块**：better-sqlite3 需 `electron-rebuild` + `asarUnpack` 配置，否则运行时加载失败
8. **CSP**：渲染进程生产环境 `default-src 'self'`，禁止 remote 加载、禁止 `unsafe-inline` / `unsafe-eval`；开发模式（未打包）例外：`script-src` / `style-src` 放行 `unsafe-inline`（react-refresh 内联脚本与 vite client 内联样式，2026-08-07 裁决）+ `connect-src ws://localhost:*`（HMR）

## 代码规范

- **新增 IPC 能力**的标准链路：`src/shared/ipc.ts` 定义类型 → preload 暴露白名单 → main 注册 handler →（如需后端能力）调 `PythonSvc.request()`
- 状态管理用 Zustand；录入表单用 ProForm；图表用 Ant Charts
- 日志用 electron-log，**禁止记录 PAT / API Key 等敏感信息**（脱敏）
- Python 侧每个 RPC 方法：入参校验 + 异常捕获，错误按 JSON-RPC error 结构返回
- 测试配套：新功能按层补测试（前端 Vitest / 引擎 pytest / 关键链路 Playwright E2E）

## 常见坑

- Python `stdout` 响应后**必须 `flush()`**，否则 Node 端收不到
- 所有 RPC 请求必须带超时（默认 30s），防止悬挂
- 未签名的 Windows 包会被 SmartScreen 拦截；`latest.yml` 必须随产物一起发布，否则 electron-updater 静默失败
- 国内网络安装/打包需镜像变量：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（Electron 二进制）+ `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（NSIS 工具链），两者缺一不可；排障先查 `%TEMP%\eb-dl-*.lock` 与孤儿 node/electron 进程
- beancount 动态导入较多，PyInstaller 用 `--collect-all beancount` 并显式收集 `beanquery`（v3 拆包）
- Monaco 需自定义 beancount 语法高亮，不要用默认语言模式

## 文档索引

| 文档                                     | 内容                       |
| ---------------------------------------- | -------------------------- |
| `README.md`                              | 文档结构与维护约定         |
| `technical-proposal/tech-stack.md`       | 技术栈清单（24 项）        |
| `technical-proposal/architecture.md`     | 整体架构、数据流、通信协议 |
| `technical-proposal/implementation-roadmap.md` | 里程碑拆分、共享契约、执行节奏 |
| `technical-proposal/design-decisions.md` | 关键设计决策（ADR）        |
| `technical-proposal/data-consistency.md` | 数据一致性、同步与冲突处理 |
| `technical-proposal/security.md`         | 密钥管理、CSP、进程边界    |
| `technical-proposal/release-pipeline.md` | CI/CD、签名、自动更新      |
