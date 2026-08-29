/**
 * 工作目录 IPC 通道：get-status / choose / open / recents。
 * open 负责校验目录 + 初始化本地 git（已有 .git 则跳过）+ 创建/接管账本文件，
 * 然后通过注入的 onWorkspaceChanged 回调通知主入口重建运行时（db / GitSync / 索引）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChooseFolderResult, OpenWorkspaceParams, OpenWorkspaceResult, WorkspaceStatus } from '../shared/ipc'
import type { GitSync } from './git-sync'
import type { IpcRegistrar } from './ipc-handlers'
import type { WorkspaceStore } from './workspace-store'

export const LEDGER_FILE = 'main.beancount'

/** 主入口注入：工作目录变更后重建 db / gitSync / 重新刷新索引 */
export interface WorkspaceDeps {
  store: WorkspaceStore
  /** 弹出系统文件夹选择框 */
  showFolderDialog(): Promise<{ canceled: boolean; filePaths: string[] }>
  /** 工作目录变更回调（index.ts 注入，用于重建运行时） */
  onWorkspaceChanged(path: string): void
  /** 当前运行时 GitSync 实例（open 时 init 本地仓库用） */
  getGit(): GitSync | null
}

function toStatus(store: WorkspaceStore): WorkspaceStatus {
  return { current: store.loadCurrent(), ledgerFile: LEDGER_FILE }
}

export function registerWorkspaceHandlers(ipc: IpcRegistrar, deps: WorkspaceDeps): void {
  ipc.handle('workspace:get-status', (): WorkspaceStatus => toStatus(deps.store))
  ipc.handle('workspace:recents', (): string[] => deps.store.loadRecents())

  ipc.handle('workspace:choose', async (): Promise<ChooseFolderResult> => {
    try {
      const result = await deps.showFolderDialog()
      if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true }
      return { ok: true, path: result.filePaths[0] }
    } catch (err) {
      return { ok: false, message: String(err) }
    }
  })

  ipc.handle('workspace:open', async (_event: unknown, raw: unknown): Promise<OpenWorkspaceResult> => {
    const p = (raw ?? {}) as Partial<OpenWorkspaceParams>
    if (typeof p.path !== 'string' || p.path.trim().length === 0) {
      return { ok: false, message: '路径不能为空' }
    }
    const dir = p.path.trim()
    if (!existsSync(dir)) {
      return { ok: false, message: `目录不存在：${dir}` }
    }

    try {
      // 确保目录存在（用户可能输入了不存在的路径）
      mkdirSync(dir, { recursive: true })

      // 先通知主入口激活工作目录（创建 db / GitSync），再做文件与 git 初始化
      deps.onWorkspaceChanged(dir)

      const ledgerPath = join(dir, LEDGER_FILE)
      if (!existsSync(ledgerPath)) {
        writeFileSync(ledgerPath, '', 'utf8')
      }

      const git = deps.getGit()
      if (!git) {
        return { ok: false, message: '内部错误：运行时未就绪' }
      }
      if (!(await git.isRepo())) {
        await git.initRepo()
      }
      await git.addLedgerFile()
      if (await git.hasUncommitted()) {
        await git.commit('init: BeanWise 工作目录')
      }

      deps.store.setCurrent(dir)
      return { ok: true, status: toStatus(deps.store) }
    } catch (err) {
      return { ok: false, message: `打开工作目录失败：${String(err)}` }
    }
  })
}
