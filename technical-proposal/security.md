# 安全设计

## 密钥管理

| 密钥 | 存储方式 | 使用方 |
|---|---|---|
| GitHub PAT | Electron safeStorage（系统钥匙串加密） | 主进程 GitSync |
| DeepSeek API Key | Electron safeStorage | 主进程代理 |

- 渲染进程**不接触任何密钥**
- AI 请求由主进程代理发出，响应再回传渲染进程

## 进程边界

```
Renderer ──(contextBridge 白名单 API)──▶ Preload ──(typed IPC)──▶ Main
                                                                    │
                              Python Engine / SQLite / Git / DeepSeek
```

- Preload 只暴露白名单方法，禁止 `ipcRenderer.send` 全量透传
- 主进程对所有 IPC 入参做类型与路径校验（防目录穿越）

## CSP

- 渲染进程禁止加载远程脚本 / 样式 / 图片；生产 CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`
- `script-src` 禁 `unsafe-inline` / `unsafe-eval`；`style-src 'unsafe-inline'` 放宽因 antd v5 CSS-in-JS；`worker-src 'self'` 因 Monaco worker 经 Vite `?worker` 本地打包为独立 chunk（M5 定稿——不用 blob/remote worker，故无需 blob 白名单）
- 仅允许连接本地后端与 DeepSeek API 白名单域名
- 开发模式（未打包）例外：`script-src` / `style-src` 放行 `unsafe-inline`（react-refresh / vite client 内联样式）+ `connect-src ws://localhost:*`（HMR），完整口径见 CLAUDE.md 约束 #8

## 其他

- 本地 SQLite 不存敏感明文（如无必要不落交易备注以外的隐私）
- electron-log 日志脱敏：不记录 PAT / API Key / 完整密码
- 自动更新包来源固定为 GitHub Releases，校验发布者签名