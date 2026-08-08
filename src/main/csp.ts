import { session } from 'electron'

export const CSP_PROD = "default-src 'self'"
// 开发模式：electron-vite HMR 需要 react-refresh 内联脚本（unsafe-inline）与 WebSocket
export const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*"

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
