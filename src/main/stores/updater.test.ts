/**
 * M8-T5：updater 状态机测试。FakeUpdater（EventEmitter）注入，驱动事件断言状态流转；
 * 真实 autoUpdater 由 main/index.ts 组装时注入（生产走 app-update.yml，E2E 走 BEANWISE_UPDATE_FEED_URL）。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUpdaterService, type UpdaterLike } from './updater'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  forceDevUpdateConfig?: boolean
  setFeedURL = vi.fn()
  checkForUpdates = vi.fn().mockResolvedValue(undefined)
  quitAndInstall = vi.fn()
}

function setup(feedUrl?: string): { fake: FakeUpdater; service: ReturnType<typeof createUpdaterService> } {
  const fake = new FakeUpdater()
  const service = createUpdaterService({ updater: fake, currentVersion: '0.1.0', feedUrl })
  return { fake, service }
}

describe('createUpdaterService', () => {
  it('初始状态：idle + 当前版本', () => {
    const { service } = setup()
    expect(service.state()).toEqual({ status: 'idle', currentVersion: '0.1.0' })
  })

  it('feedUrl 注入：forceDevUpdateConfig + setFeedURL(generic)', () => {
    const { fake } = setup('http://127.0.0.1:9999')
    expect(fake.forceDevUpdateConfig).toBe(true)
    expect(fake.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:9999' })
  })

  it('无 feedUrl：不调 setFeedURL（生产走 app-update.yml）', () => {
    const { fake } = setup()
    expect(fake.setFeedURL).not.toHaveBeenCalled()
  })

  it('事件流：checking → available → downloading → downloaded，onChanged 逐次推送', async () => {
    const { fake, service } = setup()
    const changes: string[] = []
    service.onChanged((s) => changes.push(s.status))
    await service.check()
    expect(changes).toEqual(['checking'])
    fake.emit('update-available', { version: '9.9.9' })
    expect(service.state().status).toBe('available')
    expect(service.state().availableVersion).toBe('9.9.9')
    fake.emit('download-progress', { percent: 12.6 })
    expect(service.state().status).toBe('downloading')
    expect(service.state().progress).toBe(13)
    fake.emit('update-downloaded', { version: '9.9.9' })
    expect(service.state().status).toBe('downloaded')
    expect(changes).toEqual(['checking', 'available', 'downloading', 'downloaded'])
  })

  it('update-not-available → 回到 idle，无 availableVersion，error 一并清理', () => {
    const { fake, service } = setup()
    void service.check()
    fake.emit('update-available', { version: '9.9.9' })
    fake.emit('error', new Error('network down'))
    expect(service.state().status).toBe('error')
    expect(service.state().error).toBe('network down')
    fake.emit('update-not-available')
    expect(service.state().status).toBe('idle')
    expect(service.state().availableVersion).toBeUndefined()
    expect(service.state().error).toBeUndefined()
  })

  it('error 事件 → error 状态 + 中文信息', () => {
    const { fake, service } = setup()
    fake.emit('error', new Error('network down'))
    expect(service.state().status).toBe('error')
    expect(service.state().error).toBe('network down')
  })

  it('check() 异常 → catch 落 error 状态', async () => {
    const fake = new FakeUpdater()
    fake.checkForUpdates = vi.fn().mockRejectedValue(new Error('check failed'))
    const service = createUpdaterService({ updater: fake, currentVersion: '0.1.0' })
    await service.check()
    expect(service.state().status).toBe('error')
    expect(service.state().error).toBe('check failed')
  })

  it('install() → quitAndInstall', () => {
    const { fake, service } = setup()
    service.install()
    expect(fake.quitAndInstall).toHaveBeenCalled()
  })

  it('onChanged 返回取消订阅函数', () => {
    const { fake, service } = setup()
    const changes: string[] = []
    const off = service.onChanged((s) => changes.push(s.status))
    off()
    fake.emit('update-available', { version: '9.9.9' })
    expect(changes).toEqual([])
  })
})
