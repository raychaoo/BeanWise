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

- 渲染进程禁止加载远程脚本 / 样式 / 图片（`default-src 'self'`）
- 禁止 `unsafe-inline` / `unsafe-eval`（Monaco 需要 worker 时用本地 blob 白名单）
- 仅允许连接本地后端与 DeepSeek API 白名单域名

## 其他

- 本地 SQLite 不存敏感明文（如无必要不落交易备注以外的隐私）
- electron-log 日志脱敏：不记录 PAT / API Key / 完整密码
- 自动更新包来源固定为 GitHub Releases，校验发布者签名