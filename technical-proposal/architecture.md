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
│   │ SQLite Index │   │   Python     │   │ isomorphic-git│    │
│   │ Drizzle ORM  │   │  Beancount   │   │               │    │
│   │  (缓存层)     │   │  Engine      │   │               │    │
│   └──────────────┘   └──────────────┘   └───────┬───────┘    │
│                                                 │           │
│   ┌──────────────┐                              │           │
│   │ DeepSeek API │◀──── 主进程代理（Key 不落地渲染进程）       │
│   └──────────────┘                              │           │
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

## Node ↔ Python 通信协议

- **方案**：stdio JSON-RPC 2.0，JSONL 逐行（`\n` 分隔）
- **方法清单**：`ping` / `parse_file` / `validate` / `query` / `render_report` / `shutdown`（AI 解析不走 Python，见 ADR 13）
- **进程管理**：主进程 `spawn` 管理，异常退出指数退避重启，`before-quit` 优雅关闭
- **渲染进程隔离**：渲染进程不直连 Python，一律走主进程代理

## Python 分发

- PyInstaller `--onefile` 打包为 `beancount-engine`（win 下为 `.exe`）；启动有 1~3s 解压延迟，引擎作为常驻进程可接受
- 依赖收集：`--collect-all beancount`（动态导入多）+ 显式收集 v3 拆出的子包 `beanquery`（`query` 方法依赖）
- 经 `extraResources` 打入安装包，`app.isPackaged` 时从 `process.resourcesPath` 定位
- 开发模式直接调用本机 `python3 service.py --stdio`