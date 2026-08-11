/**
 * M6-T3：同步 IPC 六通道（get-status / configure / push / pull / resolve-conflict / clear）。
 * 编排：场景 A/B/C 首同步判别、push/pull 前置快照提交、fetch → analyzeMerge 五分支消费、
 * 合并落盘（writeLedgerChecked）+ 索引重建（refreshIndex）、sync 域互斥（SYNCING，withWriteLock 外第二道闸）。
 *
 * 与 brief 的差异（Task 1/2 已确立的事实，本文件遵守）：
 * - URL 校验放行测试/E2E 通道 http://127.0.0.1:<port> / http://localhost:<port>（isomorphic-git 1.41.3
 *   无 file:// 本地传输，Task 1 起以进程内 smart-HTTP 服务器替代；GitHub https 为主通道）；
 * - 入参校验在 acquireSync 之前、try 之外 → 非法入参 reject（与 add-entry/save-file 同约定；
 *   brief 的 configure 非法入参测试即断言 rejects），且不占用/泄漏同步互斥；
 * - push/pull 的 fast-forward/clean-merge 分支提取共享辅助 applyRemoteMerge（DRY，语义不变）。
 */
import { readFileSync } from 'node:fs'
import type { ConfigureSyncParams, ConfigureSyncResult, ResolveConflictParams, ResolveConflictResult, SyncConfig, SyncResult, SyncStatus } from '../shared/ipc'
import type { DrizzleDb } from './db'
import { SYNC_BRANCH, type GitSync, type MergeStatus } from './git-sync'
import { refreshIndex } from './index-builder'
import { writeLedgerChecked } from './ledger-writer'
import type { PythonSvc } from './python-svc'
import type { IpcRegistrar } from './ipc-handlers'
import type { SyncConfigStore, TokenStore } from './token-store'
import { withWriteLock } from './write-lock'

export interface SyncDeps {
  db: DrizzleDb
  engine: PythonSvc
  ledgerPath: string
  tokens: TokenStore
  config: SyncConfigStore
  git: GitSync
  /** 可注入时间源（lastSyncAt 测试） */
  now?: () => number
}

const GITHUB_REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._/-]*)?$/
const MAX_SYNC_CONTENT_BYTES = 20 * 1024 * 1024

/** 测试/E2E 通道：本机 smart-HTTP 服务器（仅回环地址，生产 UI 只填 github 地址） */
function isLoopbackHttpUrl(u: string): boolean {
  try {
    const url = new URL(u)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port !== ''
  } catch {
    return false
  }
}

function validateConfigureParams(raw: unknown): ConfigureSyncParams {
  const p = (raw ?? {}) as Partial<ConfigureSyncParams>
  if (typeof p.repoUrl !== 'string' || (!GITHUB_REPO_URL_RE.test(p.repoUrl) && !isLoopbackHttpUrl(p.repoUrl))) {
    throw new Error('repoUrl 必须是 GitHub 仓库地址（https://github.com/owner/repo）')
  }
  if (typeof p.pat !== 'string' || p.pat.length < 1 || p.pat.length > 200) {
    throw new Error('PAT 长度必须为 1~200 字符')
  }
  return { repoUrl: p.repoUrl, pat: p.pat }
}

function validateConflictContent(raw: unknown): string {
  const p = (raw ?? {}) as Partial<ResolveConflictParams>
  if (typeof p.content !== 'string') throw new Error('content 必须是字符串')
  if (Buffer.byteLength(p.content, 'utf8') > MAX_SYNC_CONTENT_BYTES) throw new Error('合并内容超过 20MB 上限')
  return p.content
}

/** 同步互斥：push/pull/resolve/configure 任一进行中，其余触发即拒绝 */
const SYNCING = { current: false }
function acquireSync(): void {
  if (SYNCING.current) throw new Error('同步进行中，请稍候')
  SYNCING.current = true
}

/**
 * sync:get-status 用默认（读 SYNCING.current）；configure 响应内嵌的 status 须传显式 syncing
 * ——返回时 finally 尚未执行、SYNCING.current 仍为 true，直接默认取值会让响应携带瞬时的
 * syncing:true（T3 审查修复：响应描述同步完成后的状态 → 传 false）。
 */
function toStatus(config: SyncConfig | null, syncing: boolean = SYNCING.current): SyncStatus {
  return {
    configured: config !== null,
    repoUrl: config?.repoUrl,
    branch: config?.branch,
    lastSyncAt: config?.lastSyncAt ?? null,
    lastError: config?.lastError ?? null,
    syncing
  }
}

/** PAT 判空（未配置/不可用 → throw 中文 Error；错误文案不含 PAT，认证失败见 GitSync 固定文案） */
function requirePat(deps: SyncDeps): void {
  if (!deps.tokens.load()) throw new Error('未保存访问令牌（PAT），请重新配置同步')
}

/** 同步成功后刷新 lastSyncAt / lastError */
function markSynced(deps: SyncDeps, config: SyncConfig): void {
  deps.config.save({ ...config, lastSyncAt: deps.now ? deps.now() : Date.now(), lastError: null })
}
function markFailed(deps: SyncDeps, config: SyncConfig, error: string): void {
  deps.config.save({ ...config, lastError: error })
}

function requireConfig(deps: SyncDeps): SyncConfig {
  const config = deps.config.load()
  if (!config) throw new Error('尚未配置同步')
  return config
}

/** push/pull 前置：工作区脏 → 快照提交（保存后自动触发，此时必有未提交改动） */
async function snapshotLocal(deps: SyncDeps): Promise<void> {
  if (await deps.git.hasUncommitted()) {
    await deps.git.addLedgerFile()
    await deps.git.commit(`save: ${new Date().toISOString()}`)
  }
}

type MergeableStatus = Extract<MergeStatus, { kind: 'fast-forward' } | { kind: 'clean-merge' }>

/**
 * 合并提交（双亲 [HEAD, 远端]——真实 git 合并语义，第一父=本地）。
 * isomorphic-git 的显式 parent 整体替换默认 [HEAD]，只传远端会让本地历史游离（T3 审查修复）；
 * 单亲提交还会被 push 客户端快进检查拒绝（远端 ref 非祖先）。fetch 已保证远端 ref 存在。
 */
async function mergeCommit(deps: SyncDeps, message: string): Promise<string> {
  return deps.git.commit(message, [await deps.git.headOid(), await deps.git.remoteHeadOid()])
}

/**
 * push/pull 共用合并分支（DRY，从 brief 两个 handler 的重复代码提取）：
 * 合并/接管内容落盘（校验失败不落盘）→ 双亲合并提交 →（doPush 时）push（adopted=场景 C 接管 → force）
 * → 索引重建。pull 只拉不推（doPush=false）：只读 PAT 不失败、不静默发布本地改动（T3 审查修复）。
 */
async function applyRemoteMerge(deps: SyncDeps, config: SyncConfig, status: MergeableStatus, doPush: boolean): Promise<SyncResult> {
  const content = status.kind === 'fast-forward' ? status.theirsContent : status.content
  const wrote = await writeLedgerChecked(deps, content)
  if (!wrote.ok) {
    markFailed(deps, config, wrote.message ?? '合并结果校验失败')
    return { ok: false, message: wrote.message }
  }
  await deps.git.addLedgerFile()
  await mergeCommit(deps, status.kind === 'fast-forward' ? 'merge: 快进合并' : 'merge: 自动合并')
  if (doPush) await deps.git.push(config.adopted ?? false)
  await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
  markSynced(deps, config)
  return { ok: true }
}

function conflictResult(status: Extract<MergeStatus, { kind: 'conflict' }>): SyncResult {
  return { ok: false, conflict: true, base: status.base, ours: status.ours, theirs: status.theirs }
}

export function registerSyncHandlers(ipc: IpcRegistrar, deps: SyncDeps): void {
  ipc.handle('sync:get-status', (): SyncStatus => toStatus(deps.config.load()))

  ipc.handle('sync:clear', (): { ok: boolean } => {
    deps.tokens.clear()
    deps.config.clear()
    return { ok: true }
  })

  ipc.handle('sync:configure', (_event: unknown, raw: unknown): Promise<ConfigureSyncResult> =>
    withWriteLock(async () => {
      // 入参校验在 acquireSync/try 之外：非法入参 reject（与 add-entry/save-file 同约定），且不占用互斥
      const { repoUrl, pat } = validateConfigureParams(raw)
      acquireSync()
      try {
        deps.tokens.save(pat) // safeStorage 失败 → throw（配置零写入）

        // 连接测试 + 场景判别：refs 非空 → 远端已有内容
        const refs = await deps.git.listServerRefs(repoUrl)
        const hasRemote = refs.some((r) => r.ref === `refs/heads/${SYNC_BRANCH}`)
        let hasLocal: boolean
        try { hasLocal = readFileSync(deps.ledgerPath, 'utf8').length > 0 } catch { hasLocal = false }

        let config: SyncConfig = { repoUrl, branch: SYNC_BRANCH, adopted: false }
        if (!hasRemote) {
          // 场景 A：空仓 → init → commit → remote → push -u
          if (!(await deps.git.isRepo())) await deps.git.initRepo()
          await deps.git.addLedgerFile()
          if (await deps.git.hasUncommitted()) await deps.git.commit('init: 首次同步')
          await deps.git.addRemote(repoUrl)
          await deps.git.push()
        } else if (!hasLocal) {
          // 场景 B：本地无账本 → clone 到账本目录
          await deps.git.clone(repoUrl)
          // clone 只落文件、索引仍 missing——首同步用户须立即可见明细（M6 终审修复 I-1）
          await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
        } else {
          // 场景 C：两端都有 → init + commit + remote + fetch → analyzeMerge 判别
          //（unrelated：内容一致 → local-ahead 接管；不一致 → conflict(base='')）
          config.adopted = true
          if (!(await deps.git.isRepo())) await deps.git.initRepo()
          await deps.git.addLedgerFile()
          if (await deps.git.hasUncommitted()) await deps.git.commit('init: 首次同步')
          await deps.git.addRemote(repoUrl)
          await deps.git.fetch()
          const status = await deps.git.analyzeMerge()
          if (status.kind === 'conflict') {
            markFailed(deps, config, '接管冲突：本地与远端账本内容不一致')
            // 内嵌 status 传 syncing=false（返回时 finally 未执行，SYNCING.current 仍为 true——T3 审查修复）
            return { ok: false, conflict: true, base: status.base, ours: status.ours, theirs: status.theirs, status: toStatus(config, false) }
          }
          // local-ahead（内容一致）→ force push 接管（unrelated histories 非快进会被远端拒绝）
          await deps.git.push(true)
        }
        markSynced(deps, config)
        return { ok: true, status: toStatus(config, false) }
      } catch (err) {
        const config = deps.config.load()
        if (config) markFailed(deps, config, String(err))
        return { ok: false, error: String(err) }
      } finally {
        SYNCING.current = false
      }
    }))

  ipc.handle('sync:push', (): Promise<SyncResult> =>
    withWriteLock(async () => {
      acquireSync()
      try {
        const config = requireConfig(deps)
        requirePat(deps) // PAT 判空即拒绝（auth 在 GitSync 构造时已注入）
        await snapshotLocal(deps)
        await deps.git.fetch()
        const status = await deps.git.analyzeMerge()
        if (status.kind === 'up-to-date') { markSynced(deps, config); return { ok: true } }
        if (status.kind === 'local-ahead') {
          await deps.git.push(config.adopted ?? false)
          markSynced(deps, config)
          return { ok: true }
        }
        if (status.kind === 'fast-forward' || status.kind === 'clean-merge') {
          return applyRemoteMerge(deps, config, status, true)
        }
        markFailed(deps, config, '同步冲突：需要人工合并')
        return conflictResult(status)
      } catch (err) {
        const config = deps.config.load()
        if (config) markFailed(deps, config, String(err))
        return { ok: false, message: String(err) }
      } finally {
        SYNCING.current = false
      }
    }))

  ipc.handle('sync:pull', (): Promise<SyncResult> =>
    withWriteLock(async () => {
      acquireSync()
      try {
        const config = requireConfig(deps)
        requirePat(deps)
        await snapshotLocal(deps)
        await deps.git.fetch()
        const status = await deps.git.analyzeMerge()
        if (status.kind === 'up-to-date' || status.kind === 'local-ahead') { markSynced(deps, config); return { ok: true } }
        if (status.kind === 'fast-forward' || status.kind === 'clean-merge') {
          return applyRemoteMerge(deps, config, status, false)
        }
        markFailed(deps, config, '同步冲突：需要人工合并')
        return conflictResult(status)
      } catch (err) {
        const config = deps.config.load()
        if (config) markFailed(deps, config, String(err))
        return { ok: false, message: String(err) }
      } finally {
        SYNCING.current = false
      }
    }))

  ipc.handle('sync:resolve-conflict', (_event: unknown, raw: unknown): Promise<ResolveConflictResult> =>
    withWriteLock(async () => {
      // 校验在 acquireSync/try 之外：非法入参 reject，且不占用互斥
      const content = validateConflictContent(raw)
      acquireSync()
      try {
        const config = requireConfig(deps)
        requirePat(deps)
        // M6 终审修复 I-2a：冲突快照过期防护——resolve 前置 re-fetch，远端在冲突 fetch 后推进
        // → 拒绝（不写盘不 commit 不 push，工作区不动），避免 adopted force push 静默丢弃远端新提交
        let snapshotOid: string | null = null
        try { snapshotOid = await deps.git.remoteHeadOid() } catch { snapshotOid = null } // 远端无 ref（极端）
        await deps.git.fetch()
        const latestOid = await deps.git.remoteHeadOid()
        if (snapshotOid !== latestOid) {
          markFailed(deps, config, '远端已有新变更，冲突快照已过期，请重新处理冲突')
          return { ok: false, message: '远端已有新变更，冲突快照已过期，请重新处理冲突' }
        }
        const wrote = await writeLedgerChecked(deps, content)
        if (!wrote.ok) {
          markFailed(deps, config, wrote.message ?? '合并结果校验失败') // 与 push/pull 分支一致（T3 审查修复）
          return { ok: false, message: wrote.message }
        }
        await deps.git.addLedgerFile()
        await mergeCommit(deps, 'merge: 手动解决冲突')
        await deps.git.push(config.adopted ?? false)
        const result = await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
        markSynced(deps, config)
        return { ok: true, status: result.status, entryCount: result.entryCount, errorCount: result.errorCount }
      } catch (err) {
        const config = deps.config.load()
        if (config) markFailed(deps, config, String(err))
        return { ok: false, message: String(err) }
      } finally {
        SYNCING.current = false
      }
    }))
}
