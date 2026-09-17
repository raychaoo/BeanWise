# 整体技术架构

## 架构图

```plain
┌───────────────────────────────────────────────────────────────┐
│                      Electron 主进程 (Main)                    │
│                                                               │
│   ┌──────────────┐   ┌──────────────┐   ┌───────────────┐    │
│   │  IPC 路由层   │──▶│ PythonSvc    │   │  GitSync      │    │
│   │  (typed)     │   │  stdio RPC   │   │ isomorphic-git│   │
│   └──────┬───────┘   └──────┬───────┘   └───────┬───────┘    │
│          │                  │                    │           │
│   ┌──────▼───────┐   ┌──────▼───────┐   ┌───────▼───────┐    │
│   │ SQLite Index │   │   Python     │   │  Git 仓库       │   │
│   │ Drizzle ORM  │   │  Beancount   │   │  (每工作目录)   │   │
│   │ 每工作目录     │   │  Engine      │   │               │   │
│   └──────────────┘   └──────────────┘   └───────┬───────┘    │
│                                                 │           │
│   ┌──────────────┐                              │           │
│   │ DeepSeek API │◀──── 主进程代理（Key 不落地渲染进程）       │
│   └──────────────┘                              │           │
│                                                │            │
│  工作目录运行时（activateWorkspace 整体重建）:                 │
│   ledgerPath / db / GitSync / syncConfig / accountConfig      │
└─────────────────────────────────────────────────┼─────────────┘
                                                  │
┌─────────────────────────────────────────────────▼─────────────┐
│   Preload（contextBridge 白名单 API，typed wrapper）           │
└─────────────────────────────────────────────────┬─────────────┘
                                                  │ IPC
┌─────────────────────────────────────────────────▼─────────────┐
│   Renderer（React + TypeScript + Vite）                       │
│                                                               │
│   Ant Design │ ProComponents(ProForm) │ Ant Charts │ Monaco  │
│   Zustand（状态管理）                                         │
│   WorkspaceGate（未选目录门控）│ WorkspaceSwitcher（切换 reload）│
│                                                               │
│   ⬇ 所有业务能力调用一律走 IPC → 主进程 → Python/SQLite/Git   │
└───────────────────────────────────────────────────────────────┘
```

## 数据流约定

| 场景 | 链路 |
|---|---|
| 录入 / 查询 | Renderer → IPC → Main → Python Engine → SQLite 回填 |
| 文件变更 | Beancount 文件变更 → 增量解析 → 重建 SQLite 索引 |
| git 同步 | Main(GitSync) → isomorphic-git → GitHub 私有仓库（冲突 → 三路合并 UI） |
| AI 录入 | Renderer → IPC → Main 代理 → DeepSeek API（Function Calling + schema 校验） |
| 工作目录切换 | WorkspaceSwitcher → IPC open → 主进程重建运行时 → 渲染端整页 reload |

## Node ↔ Python 通信协议

- **方案**：stdio JSON-RPC 2.0，JSONL 逐行（`\n` 分隔）
- **方法清单**：`ping` / `parse_file` / `parse_entries` / `validate` / `query` / `render_report` / `shutdown`（AI 解析不走 Python，见 ADR 13）
- **进程管理**：主进程 `spawn` 管理，异常退出指数退避重启，`before-quit` 优雅关闭
- **渲染进程隔离**：渲染进程不直连 Python，一律走主进程代理

## 工作目录运行时模型（M9 定稿）

应用按「工作目录」组织账本运行时，每个工作目录独立持有：

| 组件 | 路径 | 说明 |
|---|---|---|
| 账本文件 | `<workspace>/main.beancount` | 固定文件名；首笔录入自动补账户 open 行 |
| SQLite 索引 | `<workspace>/.beanwise/index.db` | ledger_meta / entries / postings 三表，可随时重建；**已 gitignore** |
| 同步配置 | `<workspace>/.beanwise/sync-config.json` | repoUrl / branch / adopted / lastSyncAt / lastError；**已 gitignore**（本机元数据） |
| 通用账户库 | `<workspace>/.beanwise/accounts.json` | AccountEntry[]（id / name / value / description?）；**随 git 同步** |
| Excel 导入模板 | `<workspace>/.beanwise/excel-import-templates.json` | 多模板（列映射 + 方向规则 + 账户映射）；**随 git 同步** |
| `.gitignore` | `<workspace>/.gitignore` | 同步范围内的受托管块（`# >>> BeanWise 同步托管块 >>>`），只追加不覆写用户规则 |
| git 仓库 | `<workspace>/.git` | 追踪账本 + 账户库 + 模板 + `.gitignore`（范围见 `src/shared/sync-files.ts`），分支固定 main |
| 本机 git 网络配置 | electron-store `git-network`（userData，**不在工作目录内**） | M12：代理地址 + 超时。**机器级**——代理是机器/网络属性，换工作目录不该重填，也不进仓库 |

- 主进程持有一份**动态运行时**（`Runtime`：db / ledgerPath / gitSync / syncTokens / syncConfig / accountConfig），`activateWorkspace(dir)` 先关旧 DB → 重建全部组件 → fire-and-forget 刷新索引；已注册 IPC handler 经 getter 读到最新值
- PAT / API Key **不写在工作目录内**：safeStorage 加密后存 electron-store（`sync-tokens` 按工作目录路径小写键隔离、`ai-tokens`），避免凭据进仓库；M12 的 `git-network` 同理不进工作目录（代理地址不含凭据，见 ADR 29）
- 当前路径 + 最近打开列表（上限 10）存 electron-store（`workspace`）；启动时若上次目录存在则自动激活，否则渲染端显示 WorkspaceGate 选择界面
- `workspace:open` 校验目录存在与可写 → 创建/接管 `main.beancount` → 初始化本地 git（无 `.git` 则 `initRepo`）→ commit 初始快照；成功后渲染端 `window.location.reload()` 整页重载，杜绝各域 zustand store 跨目录残留状态

## Python 分发

- PyInstaller `--onefile` 打包为 `beancount-engine`（win 下为 `.exe`）；启动有 1~3s 解压延迟，引擎作为常驻进程可接受
- 依赖收集：`--collect-all beancount`（动态导入多）+ 显式收集 v3 拆出的子包 `beanquery`（`query` 方法依赖）
- 经 `extraResources` 打入安装包，`app.isPackaged` 时从 `process.resourcesPath` 定位
- 开发模式直接调用本机 `python3 service.py --stdio`