/**
 * 工作目录 IPC 通道：get-status / choose / open / recents + rename / archive / delete（批次 H）。
 * open 负责校验目录 + 初始化本地 git（已有 .git 则跳过）+ 创建/接管账本文件，
 * 然后通过注入的 onWorkspaceChanged 回调通知主入口重建运行时（db / GitSync / 索引）。
 * rename / archive / delete 均走白名单校验（仅 current/recents 已登记路径，防目录穿越）。
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ChooseFolderResult, OpenWorkspaceParams, OpenWorkspaceResult, WorkspaceOpResult, WorkspacePathParams, WorkspaceRenameParams, WorkspaceStatus } from '../shared/ipc'
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

/** 批次 H：白名单 = current ∪ recents 已登记路径（天然防目录穿越） */
function isRegisteredPath(store: WorkspaceStore, path: string): boolean {
  return store.loadCurrent() === path || store.loadRecents().includes(path)
}

/** workspace:rename 的 newName 白名单：中文/字母/数字/下划线/连字符，1-100 字符（禁路径分隔符与 ..） */
const WORKSPACE_NAME_PATTERN = /^[\w\u4e00-\u9fa5-]{1,100}$/

/** 归档目录名时间戳：yyyymmddHHmmss */
function archiveStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
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

  // ---- 批次 H：账本管理三通道（全部白名单校验，返回 WorkspaceOpResult）----

  ipc.handle('workspace:rename', (_event: unknown, raw: unknown): WorkspaceOpResult => {
    const p = (raw ?? {}) as Partial<WorkspaceRenameParams>
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    const newName = typeof p.newName === 'string' ? p.newName.trim() : ''
    if (path.length === 0) return { ok: false, message: '路径不能为空' }
    if (!isRegisteredPath(deps.store, path)) return { ok: false, message: '仅允许操作已登记的账本目录' }
    if (!WORKSPACE_NAME_PATTERN.test(newName)) {
      return { ok: false, message: '名称仅允许中文、字母、数字、下划线与连字符（1-100 字符）' }
    }
    if (!existsSync(path)) return { ok: false, message: `目录不存在：${path}` }
    const newPath = join(dirname(path), newName)
    if (existsSync(newPath)) return { ok: false, message: '同目录下已存在同名目录' }
    try {
      const wasCurrent = deps.store.loadCurrent() === path
      renameSync(path, newPath)
      deps.store.replaceRecent(path, newPath)
      if (wasCurrent) deps.onWorkspaceChanged(newPath)
      return { ok: true, newPath }
    } catch (err) {
      return { ok: false, message: `重命名失败：${String(err)}` }
    }
  })

  ipc.handle('workspace:archive', (_event: unknown, raw: unknown): WorkspaceOpResult => {
    const p = (raw ?? {}) as Partial<WorkspacePathParams>
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (path.length === 0) return { ok: false, message: '路径不能为空' }
    if (!isRegisteredPath(deps.store, path)) return { ok: false, message: '仅允许操作已登记的账本目录' }
    if (!existsSync(path)) return { ok: false, message: `目录不存在：${path}` }
    try {
      const archiveRoot = join(dirname(path), '.beanwise-archive')
      mkdirSync(archiveRoot, { recursive: true })
      const target = join(archiveRoot, `${basename(path)}-${archiveStamp(new Date())}`)
      renameSync(path, target)
      // 是 current 时 store 内部联动清空 current → 渲染端 reload 后回门控
      deps.store.removeRecent(path)
      return { ok: true, newPath: target }
    } catch (err) {
      return { ok: false, message: `归档失败：${String(err)}` }
    }
  })

  ipc.handle('workspace:delete', (_event: unknown, raw: unknown): WorkspaceOpResult => {
    const p = (raw ?? {}) as Partial<WorkspacePathParams>
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (path.length === 0) return { ok: false, message: '路径不能为空' }
    if (!isRegisteredPath(deps.store, path)) return { ok: false, message: '仅允许操作已登记的账本目录' }
    if (deps.store.loadCurrent() === path) return { ok: false, message: '不能删除当前账本，请先切换到其他账本' }
    if (!existsSync(path)) return { ok: false, message: `目录不存在：${path}` }
    try {
      rmSync(path, { recursive: true, force: false })
      deps.store.removeRecent(path)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: `删除失败：${String(err)}` }
    }
  })
}
