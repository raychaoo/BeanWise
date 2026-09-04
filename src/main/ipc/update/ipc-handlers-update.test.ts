/**
 * M8-T6：update 域 handler 测试。mock UpdaterService + broadcast，断言三通道行为。
 */
import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../../shared/ipc'
import { registerUpdateHandlers, type UpdaterServiceLike } from './ipc-handlers-update'

type Registrar = { handle: ReturnType<typeof vi.fn> }

function setup(): {
  registrar: Registrar
  updater: UpdaterServiceLike
  broadcast: ReturnType<typeof vi.fn>
} {
  const registrar = { handle: vi.fn() }
  const updater: UpdaterServiceLike = {
    state: vi.fn().mockReturnValue({ status: 'idle', currentVersion: '0.1.0' } satisfies UpdateState),
    check: vi.fn().mockResolvedValue(undefined),
    install: vi.fn(),
    onChanged: vi.fn().mockReturnValue(() => {})
  }
  const broadcast = vi.fn()
  registerUpdateHandlers(registrar, { updater, broadcast })
  return { registrar, updater, broadcast }
}

function handler(registrar: Registrar, channel: string): (...args: unknown[]) => Promise<unknown> {
  const entry = registrar.handle.mock.calls.find((c) => c[0] === channel) as [string, (...args: unknown[]) => Promise<unknown>]
  return entry[1]
}

describe('registerUpdateHandlers', () => {
  it('注册三通道 + 状态推送接线（onChanged → broadcast）', () => {
    const { registrar, updater, broadcast } = setup()
    expect(registrar.handle.mock.calls.map((c) => c[0])).toEqual(['update:check', 'update:status', 'update:install'])
    // 接线断言：register 内调 updater.onChanged(broadcast) → 捕获回调并触发 → broadcast 收到
    expect(updater.onChanged).toHaveBeenCalledWith(expect.any(Function))
    // Step 4 微调：UpdaterServiceLike 方法签名静态无 .mock（运行时为 vi.fn）→ 断言侧 cast（同 ipc-handlers-ai.test.ts 口径）
    const [cb] = (updater.onChanged as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [(s: UpdateState) => void]
    cb({ status: 'downloaded', currentVersion: '0.1.0' })
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloaded' }))
  })

  it('update:check：成功 → { ok: true }', async () => {
    const { registrar } = setup()
    const r = await handler(registrar, 'update:check')()
    expect(r).toEqual({ ok: true })
  })

  it('update:check：异常 → { ok: false, message }（check 自身 catch，此处防御）', async () => {
    const { registrar, updater } = setup()
    updater.check = vi.fn().mockRejectedValue(new Error('boom'))
    const r = await handler(registrar, 'update:check')()
    expect(r).toEqual({ ok: false, message: 'boom' })
  })

  it('update:status → 当前状态', async () => {
    const { registrar } = setup()
    const r = await handler(registrar, 'update:status')()
    expect(r).toEqual({ status: 'idle', currentVersion: '0.1.0' })
  })

  it('update:install → { ok: true } 且触发 install', async () => {
    const { registrar, updater } = setup()
    const r = await handler(registrar, 'update:install')()
    expect(r).toEqual({ ok: true })
    expect(updater.install).toHaveBeenCalled()
  })
})
