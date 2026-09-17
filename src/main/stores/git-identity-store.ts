/**
 * M13：提交人身份的持久化。
 *
 * **两个半边不同域，这是刻意的**：
 * - `manual`（手填姓名/邮箱）是**机器级**——提交人是人，不是账本目录的属性（同 M12 的代理设置）；
 * - `detected`（由 PAT 识别出的 GitHub 身份）按**工作目录小写路径**隔离——它是该目录 PAT 的
 *   派生物，必须与 PAT 同域（`ElectronWorkspaceTokenStore` 用同一个键函数）；否则换账本目录会
 *   把上一个账本的 GitHub 身份带过来，新账本的首个提交就挂错人。
 *
 * **单实例**：electron-store（conf）把整份对象缓存在内存里，两个实例会互相覆盖，故本类在应用
 * 启动时只 new 一次，工作目录路径由调用方逐次传入（`load(dir)` / `saveDetected(dir, ...)`）。
 * 单测/CI 注入内存实现（本模块 import electron-store → 不可进 vitest node 环境）。
 */
import Store from 'electron-store'
import type { DetectedGitIdentity, GitIdentityManual } from '../../shared/ipc'
import { normalizeStoredIdentity } from '../core/git-identity'
import { workspaceStorageKey } from '../utils/workspace-key'

/** 某个工作目录的身份视图（`detected` 已按该目录取出） */
export interface GitIdentityView {
  manual: GitIdentityManual | null
  detected: DetectedGitIdentity | null
}

export interface GitIdentityStore {
  load(workspaceDir: string): GitIdentityView
  saveManual(manual: GitIdentityManual | null): void
  saveDetected(workspaceDir: string, detected: DetectedGitIdentity | null): void
}

export class ElectronGitIdentityStore implements GitIdentityStore {
  private readonly store = new Store<{ identity?: unknown }>({ name: 'git-identity', defaults: {} })

  /** 读脏数据一律兜默认 / 丢弃非法项，绝不因配置损坏断掉同步 */
  load(workspaceDir: string): GitIdentityView {
    const stored = normalizeStoredIdentity(this.store.get('identity'))
    return { manual: stored.manual, detected: stored.detected[workspaceStorageKey(workspaceDir)] ?? null }
  }

  /** 只写手填值那半边——结构上保证「保存手填值不会清掉识别缓存」 */
  saveManual(manual: GitIdentityManual | null): void {
    const stored = normalizeStoredIdentity(this.store.get('identity'))
    this.store.set('identity', { manual, detected: stored.detected })
  }

  /** 只写本工作目录那一条识别缓存；`null` = 清除（`sync:clear` 与识别失败时用） */
  saveDetected(workspaceDir: string, detected: DetectedGitIdentity | null): void {
    const stored = normalizeStoredIdentity(this.store.get('identity'))
    const detectedMap = { ...stored.detected }
    const key = workspaceStorageKey(workspaceDir)
    if (detected === null) delete detectedMap[key]
    else detectedMap[key] = detected
    this.store.set('identity', { manual: stored.manual, detected: detectedMap })
  }
}
