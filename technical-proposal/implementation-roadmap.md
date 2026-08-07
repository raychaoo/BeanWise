# 实施路线图（Implementation Roadmap）

> 全项目执行的锚点：**全项目视图 = 本文件 + 6 份方案文档**，各里程碑的执行计划保持「薄」，
> 只写「改哪些文件、边界、验收标准」，具体设计一律引用对应方案文档。

## 执行节奏

```
每次只生成下一个里程碑的计划 → 独立 session 执行 → 绿灯验收 → 进入下一个
```

- 计划不提前囤：实现产生的真实信息（IPC 签名、RPC 行为）会让旧计划过期
- 每个执行 session 的上下文 ≈ 一份薄计划 + 本文件 + 相关方案文档
- 共享契约见下节，所有计划必须对齐，不得各写各的

## 里程碑总览

| # | 里程碑 | 依赖 | 绿灯验收 |
|---|---|---|---|
| M1 | 脚手架 + 构建基线 | — | `dist:win` 产出 NSIS 包可安装启动；CI（test/e2e/build）全绿 |
| M2 | Python 引擎层 | —（与 M1 可并行） | pytest 全绿；Node 侧 RPC 冒烟通过（ping/validate） |
| M3 | IPC 骨架 + SQLite 索引 | M1, M2 | 手工写入一笔交易 → 索引可见；typecheck 绿 |
| M4 | 核心录入链路 | M3 | ProForm 录一笔 → 落文件 → 校验 → 索引更新（端到端） |
| M5 | Monaco 编辑器 | M3 | 打开账本 → beancount 高亮 → 编辑保存 → 校验提示 |
| M6 | Git 同步 | M3 | 推拉到 GitHub 私有仓库；人为冲突 → 三路合并 UI 完成合并 |
| M7 | AI 辅助录入 | M3 | 自然语言 → 交易指令 → 落盘全链路；schema 校验拒绝非法输出 |
| M8 | 图表报表 + 发布加固 | M4, M5, M6, M7 | 图表渲染真实数据；升级演练；完整发布演练（tag → Release → 更新） |

```plain
M1 ──┬──▶ M3 ──┬──▶ M4 ──┬──▶ M8
M2 ──┘        ├──▶ M5    ┘
              ├──▶ M6
              └──▶ M7
```

## 共享契约（所有里程碑必须对齐）

### 目录结构

```
src/main/         # 主进程：ipc 路由、PythonSvc、GitSync、DeepSeek 代理
src/preload/      # contextBridge 白名单
src/renderer/     # React：ProForm 录入 / Monaco / 图表 / Zustand
src/shared/ipc.ts # IPC 类型契约（唯一来源）
python/           # service.py、engine/、tests/、service.spec、requirements*.txt
dist-python/      # PyInstaller 固定输出（与 electron-builder 的 dist/ 分离）
```

### Node ↔ Python（stdio JSON-RPC）

- JSON-RPC 2.0，JSONL 逐行（`\n` 分隔）；方法：`ping` / `parse_file` / `validate` / `query` / `render_report` / `shutdown`
- stdout 响应后必须 `flush()`；所有请求带超时（默认 30s）
- 主进程 spawn 管理；异常退出指数退避重启；`before-quit` 优雅关闭
- 开发模式调本机 `python3 service.py --stdio`；打包后经 `extraResources` 从 `process.resourcesPath` 定位

### IPC 契约（本 roadmap 新增约定）

- 类型定义唯一来源：`src/shared/ipc.ts` → preload 白名单 → main handler 注册，禁止旁路
- 通道命名：`{domain}:{action}` 小写 kebab，如 `ledger:validate`、`sync:push`、`ai:parse`
- 主进程对所有入参做类型与路径校验（防目录穿越）

### 数据流铁律

- Beancount 文件是唯一事实源：**先落文件 → 校验 → 重建 SQLite 索引**；禁止绕过文件写 SQLite
- 文件变更 → 增量解析 → 重建索引；增量失败回退全量并记日志

### 安全边界

- GitHub PAT / DeepSeek Key 只存主进程（safeStorage 加密），渲染进程不可见
- 渲染进程不直连 Python / SQLite / git；AI 请求走主进程代理
- CSP：生产 `default-src 'self'`，禁 remote / `unsafe-inline` / `unsafe-eval`；开发模式例外：`script-src` / `style-src` 放行 `unsafe-inline`（react-refresh / vite client 内联样式）+ `connect-src ws://localhost:*`（HMR），见 CLAUDE.md 约束 #8
- electron-log 脱敏，禁止记录 PAT / API Key

### 平台与版本（2026-08 定稿：仅 Windows）

- 平台：Windows-only（NSIS）；`latest.yml` 随产物发布；Authenticode 签名（CSC_LINK）
- 版本：Electron 最新稳定 · Node 22（CI）· Python 3.11 · Beancount v3（锁定，禁止 v2）
- 原生模块：better-sqlite3 需 `electron-rebuild` + `asarUnpack`
- PyInstaller：`--onefile` → `dist-python/`（spec 配 distpath）；`--collect-all beancount` + 显式收集 `beanquery`
- CI：test/e2e 跑 ubuntu（xvfb，测试基础设施），build/release 跑 windows

## 里程碑边界说明

| # | 做什么 | 不做（留给后续/明确排除） |
|---|---|---|
| M1 | Vite+Electron+TS 骨架、npm scripts、electron-builder 出包、CI 基线 | 业务代码；签名（留 M8） |
| M2 | Python service + JSON-RPC + 6 个方法 + pytest + PyInstaller | 增量解析策略（M3）；AI 解析（走主进程代理，不经 Python） |
| M3 | 3 层 IPC 骨架、Drizzle 表结构、增量解析→索引重建、PythonSvc 生命周期 | 业务 UI；录入表单 |
| M4 | ProForm 录入表单、校验错误展示、落文件→索引链路 | 编辑已有交易（M5）；AI 录入（M7） |
| M5 | Monaco 编辑器 + beancount 语法高亮、保存/校验、DiffEditor 基础 | 三路合并 UI（M6） |
| M6 | isomorphic-git 推拉、PAT 录入（safeStorage）、三路合并冲突 UI | 自动定时同步（可后置） |
| M7 | DeepSeek 代理、function calling tool schema、主进程 schema 校验 | 提示词工程打磨 |
| M8 | Ant Charts 报表、electron-updater 升级链、代码签名、发布演练 | — |

## 排序理由与风险

- **M1/M2 并行**：互不依赖，可两个 session 同时推进；M2 是全项目最长尾风险（beancount 动态导入打包、v3 拆包），尽早暴露
- **M3 是枢纽**：之后 M4-M7 全部只依赖 M3 的接口，M3 的契约质量决定后面四个里程碑的返工量
- **M4 先于 M5/M6/M7**：核心价值链路（录入→落盘→索引）最先闭环，验证「唯一事实源」原则可行
- **M6 冲突处理是 UX 高风险项**（自研三路合并 UI），留足迭代空间
- 最大风险：M2（PyInstaller 收集）、M6（isomorphic-git 私有仓库 + 冲突合并）、M7（deepseek-v4-flash 的 function calling 稳定性，见 ADR 12）
