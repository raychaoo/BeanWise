import { describe, expect, it } from 'vitest'
import { CSP_DEV, CSP_PROD } from './csp'

describe('CSP 策略（M2 交接钩子，CLAUDE.md 约束 #8）', () => {
  it('生产 CSP：default-src 仅 self，无 unsafe-inline / unsafe-eval / remote 源', () => {
    expect(CSP_PROD).toContain("default-src 'self'")
    expect(CSP_PROD).not.toMatch(/unsafe-inline/)
    expect(CSP_PROD).not.toMatch(/unsafe-eval/)
    expect(CSP_PROD).not.toMatch(/https?:\/\//)
  })

  it('开发 CSP：script/style 放行 unsafe-inline（react-refresh/vite 内联），connect-src 放行 HMR WebSocket', () => {
    expect(CSP_DEV).toMatch(/script-src 'self' 'unsafe-inline'/)
    expect(CSP_DEV).toMatch(/style-src 'self' 'unsafe-inline'/)
    expect(CSP_DEV).toMatch(/connect-src 'self' ws:\/\/localhost:\*/)
  })
})
