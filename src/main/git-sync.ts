/**
 * M6：isomorphic-git 薄封装。账本目录即 git 工作区（唯一事实源铁律），
 * 只追踪账本文件；分支固定 main、remote 固定 origin。
 * 所有远端操作带 30s 超时防悬挂；认证经 AuthProvider 注入（PAT 主进程持有）。
 *
 * 与 brief 代码的 API 差异（isomorphic-git 1.41.3 实测）：
 * - fs 传 node:fs（`git.fs` 在 1.41.3 未导出）；
 * - remote 命令名为 `addRemote`（`git.remote` 在 1.x 已不存在）；
 * - `git.mergeFile` 未导出（1.x 内置为 merge 的 mergeDriver），改用同款 diff3
 *   算法库本地实现 mergeFile，语义与 brief 的 `mergeFile({ marker: false })` 一致。
 */
import { existsSync, mkdirSync } from 'node:fs'
import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import git, { type AuthCallback, type AuthFailureCallback } from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import diff3Merge from 'diff3'

export const GIT_AUTHOR = { name: 'BeanWise', email: 'beanwise@local' }
export const SYNC_BRANCH = 'main'
export const SYNC_REMOTE = 'origin'

export interface AuthProvider { (): { username: string; password: string } }

export type MergeStatus =
  | { kind: 'up-to-date' }
  | { kind: 'local-ahead' }
  | { kind: 'fast-forward'; theirsContent: string }
  | { kind: 'clean-merge'; content: string }
  | { kind: 'conflict'; base: string; ours: string; theirs: string }

export interface GitSyncOptions {
  ledgerPath: string
  auth?: AuthProvider
  /** 远端操作超时（ms），默认 30_000 */
  timeoutMs?: number
}

/** 行分割（保留行尾符），与 isomorphic-git 内部 mergeFile 的 LINEBREAKS 一致 */
const LINEBREAKS = /^.*(\r?\n|$)/gm

/**
 * 文件级三路合并（diff3，同 isomorphic-git 内置算法）。
 * 无冲突 → cleanMerge=true 返回合并文本；有冲突 → cleanMerge=false，
 * 冲突 hunk 不产出文本（marker:false 语义），调用方改用三路快照交 UI 处理。
 */
function mergeFile(ours: string, base: string, theirs: string): { cleanMerge: boolean; mergedText: string } {
  const result = diff3Merge(
    ours.match(LINEBREAKS) ?? [],
    base.match(LINEBREAKS) ?? [],
    theirs.match(LINEBREAKS) ?? []
  )
  let cleanMerge = true
  let mergedText = ''
  for (const item of result) {
    if ('ok' in item) {
      mergedText += item.ok.join('')
    } else {
      cleanMerge = false
    }
  }
  return { cleanMerge, mergedText }
}

export class GitSync {
  private readonly dir: string
  private readonly file: string
  private readonly auth: AuthProvider
  private readonly timeoutMs: number

  constructor(opts: GitSyncOptions) {
    this.dir = dirname(opts.ledgerPath)
    this.file = basename(opts.ledgerPath)
    this.auth = opts.auth ?? (() => ({ username: 'x-access-token', password: 'x-oauth-basic' }))
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  /** 所有远端操作包超时（本地文件协议同样计数，防 io 悬挂） */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`git 操作超时（${this.timeoutMs}ms）`)), this.timeoutMs))
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

  async addLedgerFile(): Promise<void> {
    await git.add({ fs, dir: this.dir, filepath: this.file })
  }

  /**
   * commit。parent 可选：合并提交须带双亲（默认仅 HEAD）——push 的客户端快进检查要求
   * 远端 ref 是 push 提交的祖先，单亲合并提交在真实 git 服务器与 isomorphic-git 客户端
   * 均被拒（PushRejectedError），M6-T3 实测后补充。
   */
  async commit(message: string, parent?: string[]): Promise<string> {
    return git.commit({ fs, dir: this.dir, message, author: GIT_AUTHOR, parent })
  }

  async addRemote(url: string): Promise<void> {
    await git.addRemote({ fs, dir: this.dir, remote: SYNC_REMOTE, url, force: true })
  }

  async fetch(): Promise<void> {
    await this.withTimeout(git.fetch({
      fs, http, dir: this.dir, remote: SYNC_REMOTE, ref: SYNC_BRANCH,
      singleBranch: true, onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
  }

  private async readBlobText(oid: string): Promise<string> {
    // oid 是 commit/tree 时 readBlob 必须带 filepath 走树遍历（裸 oid 仅限 blob）
    const { blob } = await git.readBlob({ fs, dir: this.dir, oid, filepath: this.file })
    return Buffer.from(blob).toString('utf8')
  }

  /**
   * fetch 后合并分析（Global Constraints「合并语义」）：
   * ours=HEAD blob、theirs=refs/remotes/origin/main；unrelated（findMergeBase 返回空数组）
   * → 内容一致 local-ahead / 不一致 conflict(base='')。
   */
  async analyzeMerge(): Promise<MergeStatus> {
    const oursOid = await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' })
    let theirsOid: string
    try {
      theirsOid = await git.resolveRef({ fs, dir: this.dir, ref: `refs/remotes/${SYNC_REMOTE}/${SYNC_BRANCH}` })
    } catch {
      return { kind: 'local-ahead' } // 远端无 ref（未 fetch 过/空仓）
    }
    if (oursOid === theirsOid) return { kind: 'up-to-date' }
    // findMergeBase 实际返回 oid 数组（同祖先→[base]，unrelated→[]，brief 的 null 判断不适用）
    const [baseOid] = (await git.findMergeBase({ fs, dir: this.dir, oids: [oursOid, theirsOid] })) as string[]
    const ours = await this.readBlobText(oursOid)
    if (baseOid === undefined) {
      // unrelated（场景 C 接管）：内容一致 → 直接接管；不一致 → 三路（base 空）
      const theirs = await this.readBlobText(theirsOid)
      if (ours === theirs) return { kind: 'local-ahead' }
      return { kind: 'conflict', base: '', ours, theirs }
    }
    if (baseOid === oursOid) return { kind: 'fast-forward', theirsContent: await this.readBlobText(theirsOid) }
    if (baseOid === theirsOid) return { kind: 'local-ahead' }
    const theirs = await this.readBlobText(theirsOid)
    const base = await this.readBlobText(baseOid)
    const merged = mergeFile(ours, base, theirs)
    if (merged.cleanMerge) return { kind: 'clean-merge', content: merged.mergedText }
    return { kind: 'conflict', base, ours, theirs }
  }

  async push(force = false): Promise<void> {
    await this.withTimeout(git.push({
      fs, http, dir: this.dir, remote: SYNC_REMOTE, ref: SYNC_BRANCH, force,
      onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
  }

  /** fetch 后远端分支 oid（合并提交的第二父；push 快进检查需要） */
  async remoteHeadOid(): Promise<string> {
    return git.resolveRef({ fs, dir: this.dir, ref: `refs/remotes/${SYNC_REMOTE}/${SYNC_BRANCH}` })
  }

  async clone(url: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    await this.withTimeout(git.clone({
      fs, http, dir: this.dir, url, ref: SYNC_BRANCH,
      singleBranch: true, onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
  }

  async listServerRefs(url: string): Promise<Array<{ ref: string; oid: string }>> {
    const refs = await this.withTimeout(git.listServerRefs({
      url, http, onAuth: this.onAuth(), onAuthFailure: this.onAuthFailure()
    }))
    return refs.map((r) => ({ ref: r.ref, oid: r.oid }))
  }

  async hasUncommitted(): Promise<boolean> {
    const matrix = await git.statusMatrix({ fs, dir: this.dir })
    return matrix.some(([, head, workdir]) => head !== workdir)
  }
}
