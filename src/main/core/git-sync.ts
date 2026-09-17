/**
 * M6/M11：isomorphic-git 薄封装。账本目录即 git 工作区（唯一事实源铁律）。
 *
 * 追踪文件集见 `shared/sync-files.ts`：账本 + 账户库 + Excel 导入模板 + 受托管 `.gitignore`；
 * `.beanwise/index.db`（可重建的索引缓存）与 `.beanwise/sync-config.json`（本机同步元数据）
 * 由托管块忽略，**永不提交**。分支固定 main、remote 固定 origin，远端操作带 30s 超时防悬挂。
 *
 * 与 brief 代码的 API 差异（isomorphic-git 1.41.3 实测）：
 * - fs 传 node:fs（`git.fs` 在 1.41.3 未导出）；
 * - remote 命令名为 `addRemote`（`git.remote` 在 1.x 已不存在）；
 * - `git.mergeFile` 未导出（1.x 内置为 merge 的 mergeDriver），三路合并改由 core/merge-engine
 *   用同款 diff3 算法库实现（语义与 brief 的 `mergeFile({ marker: false })` 一致）；
 * - `git.add` 对**不存在**的文件抛 `NotFoundError`（源码 addToIndex），故 add 前必须 existsSync 过滤；
 * - `git.add` 对**未跟踪且被 .gitignore 命中**的路径会静默跳过（源码 addToIndex
 *   `if (!force && !isTracked) { if (ignored) return }`）——用户自己的 .gitignore 若写了
 *   `.beanwise/`，账户库会永远同步不出去，因此 add 必须 `force: true`；
 * - `git.remove` 幂等（GitIndex.delete 对不存在的条目 no-op），可无脑用于「工作区已删」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import git, { Errors, type AuthCallback, type AuthFailureCallback } from 'isomorphic-git'
import type { HttpClient } from 'isomorphic-git/http/node'
import { SYNC_GITIGNORE_BEGIN, SYNC_GITIGNORE_BLOCK, SYNC_GITIGNORE_FILE, SYNC_LEDGER_FILE, SYNC_TRACKED_FILES } from '../../shared/sync-files'
import type { GitNetworkConfig } from '../../shared/ipc'
import { createGitHttp } from './git-network'
import type { FileTriple } from './merge-engine'

export const GIT_AUTHOR = { name: 'BeanWise', email: 'beanwise@local' }
export const SYNC_BRANCH = 'main'
export const SYNC_REMOTE = 'origin'

export interface AuthProvider { (): { username: string; password: string } }

/**
 * 合并分析结论（M11 多文件）：
 * - up-to-date / local-ahead：无需合并（后者可能是本地领先，也可能本地已有全部远端内容）；
 * - merge：需要逐文件三路合并——`files` 为每个追踪文件的三态（null = 该侧无此文件），
 *   冲突判定与结果推导全部交给 core/merge-engine（本层只负责取数据）。
 */
export type MergeStatus =
  | { kind: 'up-to-date' }
  | { kind: 'local-ahead' }
  | { kind: 'merge'; files: FileTriple[]; fastForward: boolean }

export interface GitSyncOptions {
  ledgerPath: string
  /** 覆盖追踪文件集（测试用）；缺省 SYNC_TRACKED_FILES，其中账本项按 ledgerPath 的实际文件名替换 */
  trackedFiles?: readonly string[]
  auth?: AuthProvider
  /** 远端操作超时（ms），默认 30_000；被 `network` 的 timeoutSec 覆盖（后者优先） */
  timeoutMs?: number
  /**
   * M12 本机网络配置（代理 + 超时）——**每次远端调用求值**，故设置改完立即生效、无需重建 GitSync。
   * 缺省（测试/未注入）→ 直连 + timeoutMs。
   */
  network?: () => GitNetworkConfig | null
}

export class GitSync {
  private readonly dir: string
  /** 追踪文件（相对工作区路径）——提交、三路合并、脏检查全部以它为准 */
  private readonly files: readonly string[]
  private readonly auth: AuthProvider
  private readonly timeoutMs: number
  private readonly network?: () => GitNetworkConfig | null
  /** 包了代理注入的 http 插件（唯一注入面，见 core/git-network） */
  private readonly http: HttpClient

  constructor(opts: GitSyncOptions) {
    this.dir = dirname(opts.ledgerPath)
    const ledgerFile = basename(opts.ledgerPath)
    this.files = (opts.trackedFiles ?? SYNC_TRACKED_FILES).map((f) => (f === SYNC_LEDGER_FILE ? ledgerFile : f))
    this.auth = opts.auth ?? (() => ({ username: 'x-access-token', password: 'x-oauth-basic' }))
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.network = opts.network
    this.http = createGitHttp(() => this.network?.() ?? null)
  }

  /** 追踪文件集（IPC 层用于「本地是否已有内容」判据等） */
  get trackedFiles(): readonly string[] {
    return this.files
  }

  /** 生效超时：本机网络配置（秒）优先，缺省回落到构造参数（默认 30s） */
  private timeoutMsOf(): number {
    const sec = this.network?.()?.timeoutSec
    return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec * 1000 : this.timeoutMs
  }

  /** 所有远端操作包超时（本地文件协议同样计数，防 io 悬挂） */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    const ms = this.timeoutMsOf()
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`git 操作超时（${ms}ms）：请检查网络，或在「Git 同步设置 → 网络」里配置本机代理`)), ms))
    ])
  }

  private onAuth(): AuthCallback { return () => this.auth() }
  private onAuthFailure(): AuthFailureCallback {
    return () => { throw new Error('认证失败：请检查 PAT 是否有效（需 repo scope）') }
  }

  async isRepo(): Promise<boolean> {
    try { await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' }); return true } catch {
      // 新库 HEAD 未指向实际分支（unborn，尚无提交）时 resolveRef 抛 NotFound，
      // 但 .git/HEAD 存在即视为仓库（brief 的 isRepo 测试要求 init 后即为 true）
      return existsSync(join(this.dir, '.git', 'HEAD'))
    }
  }

  async initRepo(): Promise<void> {
    await git.init({ fs, dir: this.dir, defaultBranch: SYNC_BRANCH })
  }

  private readTextAt(filepath: string): string | null {
    try { return readFileSync(join(this.dir, filepath), 'utf8') } catch { return null }
  }

  /**
   * 幂等纳管 `.gitignore` 托管块：文件缺失 → 创建；已有内容但无 marker → **追加**；
   * 已含 marker → 原样不动。**绝不覆写用户自己的忽略规则。**
   */
  async ensureGitignore(): Promise<void> {
    const path = join(this.dir, SYNC_GITIGNORE_FILE)
    const current = this.readTextAt(SYNC_GITIGNORE_FILE)
    if (current !== null && current.includes(SYNC_GITIGNORE_BEGIN)) return
    const body = current === null || current.trim() === ''
      ? `${SYNC_GITIGNORE_BLOCK}\n`
      : `${current.replace(/\s+$/, '')}\n\n${SYNC_GITIGNORE_BLOCK}\n`
    writeFileSync(path, body, 'utf8')
  }

  /**
   * 把追踪文件集同步到 git 索引（提交的前提——`git.commit` 取的是索引而非工作区）：
   * 存在的 → add（force：见文件头 .gitignore 说明）；已从工作区删除的 → remove（幂等）。
   * `.gitignore` 在此统一纳管（唯一入口，保证任何提交路径都带上忽略规则）。
   */
  async addTrackedFiles(): Promise<void> {
    await this.ensureGitignore()
    const present: string[] = []
    for (const filepath of this.files) {
      if (existsSync(join(this.dir, filepath))) present.push(filepath)
      else await git.remove({ fs, dir: this.dir, filepath })
    }
    if (present.length > 0) {
      await git.add({ fs, dir: this.dir, filepath: [...present], force: true })
    }
  }

  /**
   * commit。parent 可选：isomorphic-git 的显式 parent 数组会**整体替换**默认 [HEAD]（不前置，
   * 源码 1.41.3 _commit「if (!parent) parent = refOid ? [refOid] : []」），合并提交须由调用方
   * 显式传 [HEAD_oid, ...extraParents]（见 ipc-handlers-sync 的 mergeCommit）；普通快照提交
   * （save: ...）不传 parent，保持单亲 [HEAD]。
   */
  async commit(message: string, parent?: string[]): Promise<string> {
    return git.commit({ fs, dir: this.dir, message, author: GIT_AUTHOR, parent })
  }

  async addRemote(url: string): Promise<void> {
    await git.addRemote({ fs, dir: this.dir, remote: SYNC_REMOTE, url, force: true })
  }

  async fetch(): Promise<void> {
    await this.withTimeout(git.fetch({
      fs, http: this.http, dir: this.dir, remote: SYNC_REMOTE, ref: SYNC_BRANCH,
      singleBranch: true, onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
  }

  /** 指定 commit 树中某文件的文本；树中无此文件 → null（三态语义需要） */
  async blobTextAt(oid: string, filepath: string): Promise<string | null> {
    try {
      // oid 是 commit/tree 时 readBlob 必须带 filepath 走树遍历（裸 oid 仅限 blob）
      const { blob } = await git.readBlob({ fs, dir: this.dir, oid, filepath })
      return Buffer.from(blob).toString('utf8')
    } catch (err) {
      if (err instanceof Errors.NotFoundError) return null
      throw err
    }
  }

  /**
   * fetch 后合并分析（Global Constraints「合并语义」）：
   * ours=HEAD、theirs=refs/remotes/origin/main、base=findMergeBase（unrelated → 无 base，逐文件为 null）。
   * 仅做「取哪一版」的判断，逐文件冲突与合并结果交由 core/merge-engine 推导。
   */
  async analyzeMerge(): Promise<MergeStatus> {
    const oursOid = await this.headOid()
    let theirsOid: string
    try {
      theirsOid = await this.remoteHeadOid()
    } catch {
      return { kind: 'local-ahead' } // 远端无 ref（未 fetch 过/空仓）
    }
    if (oursOid === theirsOid) return { kind: 'up-to-date' }
    // findMergeBase 实际返回 oid 数组（同祖先→[base]，unrelated→[]，brief 的 null 判断不适用）
    const [baseOid] = (await git.findMergeBase({ fs, dir: this.dir, oids: [oursOid, theirsOid] })) as string[]
    if (baseOid === theirsOid) return { kind: 'local-ahead' }
    const files: FileTriple[] = []
    let fastForward = true
    for (const path of this.files) {
      const ours = await this.blobTextAt(oursOid, path)
      const theirs = await this.blobTextAt(theirsOid, path)
      const base = baseOid === undefined ? null : await this.blobTextAt(baseOid, path)
      // 任一侧相对 base 都有改动 → 不是快进（仅用于提交信息措辞）
      if (base !== ours && base !== theirs && ours !== theirs) fastForward = false
      files.push({ path, base, ours, theirs })
    }
    return { kind: 'merge', files, fastForward }
  }

  async push(force = false): Promise<void> {
    await this.withTimeout(git.push({
      fs, http: this.http, dir: this.dir, remote: SYNC_REMOTE, ref: SYNC_BRANCH, force,
      onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
  }

  /** HEAD oid（合并提交的第一父——显式 parent 时默认 [HEAD] 被整体替换，需调用方自取补齐） */
  async headOid(): Promise<string> {
    return git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' })
  }

  /** fetch 后远端分支 oid（合并提交的第二父；push 快进检查需要） */
  async remoteHeadOid(): Promise<string> {
    return git.resolveRef({ fs, dir: this.dir, ref: `refs/remotes/${SYNC_REMOTE}/${SYNC_BRANCH}` })
  }

  async clone(url: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    await this.withTimeout(git.clone({
      fs, http: this.http, dir: this.dir, url, ref: SYNC_BRANCH,
      singleBranch: true, onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
  }

  async listServerRefs(url: string): Promise<Array<{ ref: string; oid: string }>> {
    const refs = await this.withTimeout(git.listServerRefs({
      url, http: this.http, onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
    return refs.map((r) => ({ ref: r.ref, oid: r.oid }))
  }

  /**
   * 追踪文件集是否有未提交改动（HEAD 与工作区逐文件比较）。
   *
   * **不能用 `statusMatrix({ fs, dir })` 全工作区扫描**：未跟踪文件在矩阵里是 `[path, 0, 2, 0]`，
   * `head !== workdir` 恒真——`.beanwise/index.db` 长期存在会让本方法永远返回 true，
   * 于是每次 push/pull 都产生一个空提交（M11 修复的现存 bug）。
   * 逐文件比对 HEAD blob 也顺带免疫 statusMatrix 的路径前缀匹配（`accounts.json.bak` 之类）。
   */
  async hasUncommitted(): Promise<boolean> {
    let headOid: string | null = null
    try {
      headOid = await this.headOid()
    } catch {
      headOid = null // unborn 新库（尚无提交）
    }
    for (const filepath of this.files) {
      const disk = this.readTextAt(filepath)
      const head = headOid === null ? null : await this.blobTextAt(headOid, filepath)
      if (disk !== head) return true
    }
    return false
  }
}
