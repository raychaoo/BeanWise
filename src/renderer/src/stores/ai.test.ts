import { beforeEach, expect, it, vi } from 'vitest'

// vi.mock 工厂在 import 求值期解析，直接引用顶层 const 会 TDZ（vitest 4.1.10 实测）；
// vi.hoisted 提前初始化（同 sync.test.ts）
const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useAiStore } from './ai'

type StubApi = {
  getAiStatus: ReturnType<typeof vi.fn>
  saveAiConfig: ReturnType<typeof vi.fn>
  clearAiConfig: ReturnType<typeof vi.fn>
}

function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
  const api: StubApi = {
    getAiStatus: vi.fn().mockResolvedValue({ configured: false, model: 'deepseek-v4-flash' }),
    saveAiConfig: vi.fn().mockResolvedValue({ ok: true }),
    clearAiConfig: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useAiStore.setState({ status: null })
  Object.values(message).forEach((m) => m.mockClear())
})

it('loadStatus：已配置 → status 落 store', async () => {
  const api = stubBeanwise({ getAiStatus: vi.fn().mockResolvedValue({ configured: true, model: 'deepseek-v4-flash' }) })
  await useAiStore.getState().loadStatus()
  expect(useAiStore.getState().status?.configured).toBe(true)
  expect(api.getAiStatus).toHaveBeenCalled()
})

it('loadStatus：失败 → status null + error 提示', async () => {
  stubBeanwise({ getAiStatus: vi.fn().mockRejectedValue(new Error('boom')) })
  await useAiStore.getState().loadStatus()
  expect(useAiStore.getState().status).toBeNull()
  expect(message.error).toHaveBeenCalled()
})

it('saveConfig：成功 → 刷新状态 + success 提示 + 返回 true', async () => {
  const api = stubBeanwise({
    saveAiConfig: vi.fn().mockResolvedValue({ ok: true }),
    getAiStatus: vi.fn().mockResolvedValue({ configured: true, model: 'deepseek-v4-flash' })
  })
  const ok = await useAiStore.getState().saveConfig('sk-1')
  expect(ok).toBe(true)
  expect(api.saveAiConfig).toHaveBeenCalledWith({ apiKey: 'sk-1' })
  expect(useAiStore.getState().status?.configured).toBe(true)
  expect(message.success).toHaveBeenCalled()
})

it('saveConfig：失败 → error 提示 + 返回 false', async () => {
  stubBeanwise({ saveAiConfig: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) })
  const ok = await useAiStore.getState().saveConfig('sk-1')
  expect(ok).toBe(false)
  expect(message.error).toHaveBeenCalled()
})

it('clearConfig：成功 → 状态未配置 + success 提示', async () => {
  stubBeanwise()
  await useAiStore.getState().clearConfig()
  expect(useAiStore.getState().status?.configured).toBe(false)
  expect(message.success).toHaveBeenCalled()
})
