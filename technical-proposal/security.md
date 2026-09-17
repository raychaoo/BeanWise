# 安全设计

## 密钥管理

| 密钥 | 存储方式 | 使用方 |
|---|---|---|
| GitHub PAT | Electron safeStorage 加密 → base64 → electron-store `sync-tokens`（按工作目录路径小写键隔离） | 主进程 GitSync |
| DeepSeek API Key | Electron safeStorage 加密 → base64 → electron-store `ai-tokens` | 主进程代理 |

- 渲染进程**不接触任何密钥**
- AI 请求由主进程代理发出，响应再回传渲染进程
- PAT / Key 密文存应用 userData，**不落账本工作目录**（避免凭据进 git 仓库）
- 本机代理配置（electron-store `git-network`，M12）是**明文普通设置**，故 `parseProxyUrl` **拒绝携带用户名密码的代理地址**（密钥只进 safeStorage，见 ADR 29）；代理地址也不会被写进错误信息以外的日志/上报
- 提交人身份（electron-store `git-identity`，M13）**不含密钥**：手填的姓名/邮箱是明文普通设置；PAT 自动识别用该工作目录的 PAT 调 `GET https://api.github.com/user`，走 `https.request` + 代理 `CONNECT` 隧道（隧道内是到 api.github.com 的端到端 TLS）——**代理只看得到目标主机名，看不到 `Authorization` 头**。API 根只由主进程 env 注入且白名单只放行官方域名与回环明文，渲染端**无法**把 PAT 指到任意地址（见 ADR 30）；识别请求与响应都不落日志
- 手填提交人**拒绝**换行/尖括号/控制字符：isomorphic-git 的 `formatAuthor` 零转义，GitHub 昵称又是用户可改的自由文本——不拦就能往 commit 对象里注入头行（识别值走净化路径）

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
- 自动更新包来源固定为 GitHub Releases；无签名发布（M8 裁决，electron-updater 不校验 Authenticode），证书到位后补签