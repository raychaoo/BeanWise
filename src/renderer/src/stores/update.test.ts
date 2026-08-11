/**
 * M8-T6：update store 测试（node 环境 mock window.beanwise，模式同 ai.test.ts）。
 * init：拉初始状态 + 订阅事件推送；check/install 透传 window.beanwise。
 */
import { beforeEach, expect, it, vi } from 'vitest'

const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useUpdateStore } from './update'

type StubApi = {
  getUpdateStatus: ReturnType<typeof vi.fn>
  checkForUpdates: ReturnType<typeof vi.fn>
  installUpdate: ReturnType<typeof vi.fn>
  onUpdateStatusChanged: ReturnType<typeof vi.fn>
}

function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
  const api: StubApi = {
    getUpdateStatus: vi.fn().mockResolvedValue({ status: 'idle', currentVersion: '0.1.0' }),
    checkForUpdates: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: true }),
    onUpdateStatusChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useUpdateStore.setState({ state: null })
  Object.values(message).forEach((m) => m.mockClear())
})

it('init：拉初始状态 + 订阅推送（事件回调落 store）', async () => {
  const api = stubBeanwise()
  await useUpdateStore.getState().init()
  expect(useUpdateStore.getState().state).toEqual({ status: 'idle', currentVersion: '0.1.0' })
  expect(api.onUpdateStatusChanged).toHaveBeenCalled()
  // 触发订阅回调 → store 更新（模拟 main → renderer 推送）
  const [cb] = api.onUpdateStatusChanged.mock.calls[0] as [(s: { status: string; currentVersion: string }) => void]
  cb({ status: 'downloaded', currentVersion: '0.1.0' })
  expect(useUpdateStore.getState().state?.status).toBe('downloaded')
})

it('check：透传 beanwise，成功返回 true', async () => {
  const api = stubBeanwise()
  const ok = await useUpdateStore.getState().check()
  expect(ok).toBe(true)
  expect(api.checkForUpdates).toHaveBeenCalled()
})

it('check：失败 → message.error 提示', async () => {
  stubBeanwise({ checkForUpdates: vi.fn().mockResolvedValue({ ok: false, message: '网络错误' }) })
  const ok = await useUpdateStore.getState().check()
  expect(ok).toBe(false)
  expect(message.error).toHaveBeenCalled()
})

it('install：透传 beanwise', async () => {
  const api = stubBeanwise()
  await useUpdateStore.getState().install()
  expect(api.installUpdate).toHaveBeenCalled()
})
