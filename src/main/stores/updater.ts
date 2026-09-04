/**
 * M8 updater 状态机（T5）：封装 electron-updater，事件 → UpdateState 单向映射。
 * autoUpdater 注入式（单测传 FakeUpdater；生产传 electron-updater 单例 autoUpdater）。
 * feedUrl 注入（BEANWISE_UPDATE_FEED_URL，测试/E2E）→ forceDevUpdateConfig + setFeedURL(generic)；
 * 生产无 feedUrl → 走 electron-builder 生成的 app-update.yml（provider github）。
 */
import type { UpdateState, UpdateStatus } from '../../shared/ipc'

/** autoUpdater 注入抽象（electron-updater 的 AutoUpdater 是 EventEmitter 子类，结构兼容） */
export interface UpdaterLike {
  forceDevUpdateConfig?: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  setFeedURL(options: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<unknown> | void
  quitAndInstall(): void
}

export interface UpdaterService {
  state(): UpdateState
  /** 触发检查；异常自行 catch 落 error 状态，不向上抛 */
  check(): Promise<void>
  install(): void
  /** 状态变更订阅，返回取消订阅函数 */
  onChanged(cb: (state: UpdateState) => void): () => void
}

export function createUpdaterService(deps: {
  updater: UpdaterLike
  currentVersion: string
  feedUrl?: string
}): UpdaterService {
  const { updater } = deps
  const listeners = new Set<(state: UpdateState) => void>()
  let state: UpdateState = { status: 'idle', currentVersion: deps.currentVersion }

  function setStatus(status: UpdateStatus, patch: Partial<UpdateState> = {}): void {
    state = { ...state, status, ...patch }
    listeners.forEach((cb) => cb(state))
  }

  if (deps.feedUrl) {
    // 测试/E2E：dev 模式无 app-update.yml，编程注入 generic 更新源
    updater.forceDevUpdateConfig = true
    updater.setFeedURL({ provider: 'generic', url: deps.feedUrl })
  }

  updater.on('checking-for-update', () => setStatus('checking'))
  updater.on('update-available', (info: { version?: string }) => {
    setStatus('available', { availableVersion: info?.version })
  })
  updater.on('update-not-available', () => setStatus('idle', { availableVersion: undefined, progress: undefined, error: undefined }))
  updater.on('download-progress', (p: { percent?: number }) => {
    setStatus('downloading', { progress: Math.round(p?.percent ?? 0) })
  })
  updater.on('update-downloaded', () => setStatus('downloaded'))
  updater.on('error', (err: unknown) => {
    setStatus('error', { error: err instanceof Error ? err.message : String(err) })
  })

  return {
    state: () => state,
    check: async () => {
      setStatus('checking')
      try {
        await updater.checkForUpdates()
      } catch (err) {
        setStatus('error', { error: err instanceof Error ? err.message : String(err) })
      }
    },
    install: () => {
      updater.quitAndInstall()
    },
    onChanged: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
