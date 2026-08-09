import { session } from 'electron'

// 生产：antd v5 CSS-in-JS 运行时注入 <style>，style-src 放宽 unsafe-inline（2026-08-09 裁决，
// 见 CLAUDE.md 约束 #8）；script-src 保持严格（禁 unsafe-inline / unsafe-eval）
export const CSP_PROD = "default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'"
// 开发模式：electron-vite HMR 需要 react-refresh 内联脚本（unsafe-inline）与 WebSocket
export const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*; worker-src 'self'"

/** 注入 CSP 响应头；isPackaged 注入（可测，主进程传 app.isPackaged） */
export function applyCsp(isPackaged: boolean): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isPackaged ? CSP_PROD : CSP_DEV
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}
