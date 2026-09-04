/**
 * M8 update 域 IPC（T6）：三通道 + 状态推送接线（updater 变化 → broadcast →
 * webContents.send(UPDATE_STATUS_CHANNEL)）。渲染端经 preload onUpdateStatusChanged 订阅。
 */
import type { UpdateCheckResult, UpdateInstallResult, UpdateState } from '../../../shared/ipc'
import type { UpdaterService } from '../../stores/updater'
import type { IpcRegistrar } from '../ledger/ipc-handlers'

/** handler 依赖：UpdaterService 的子集（单测 mock 用） */
export interface UpdaterServiceLike {
  state(): UpdateState
  check(): Promise<void>
  install(): void
  onChanged(cb: (state: UpdateState) => void): () => void
}

export function registerUpdateHandlers(
  ipc: IpcRegistrar,
  deps: { updater: UpdaterServiceLike; broadcast: (state: UpdateState) => void }
): void {
  const { updater, broadcast } = deps
  updater.onChanged(broadcast)

  ipc.handle('update:check', async (): Promise<UpdateCheckResult> => {
    try {
      await updater.check()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipc.handle('update:status', (): UpdateState => updater.state())

  ipc.handle('update:install', (): UpdateInstallResult => {
    updater.install()
    return { ok: true }
  })
}
