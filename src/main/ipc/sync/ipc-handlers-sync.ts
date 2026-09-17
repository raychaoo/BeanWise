/**
 * M6/M11/M12/M13：同步 IPC 十二通道。
 * M6/M11 六通道：get-status / configure / push / pull / resolve-conflict / clear。
 * M12 三通道：get-network / save-network / test-connection（本机代理与超时，见 core/git-network）。
 * M13 三通道：get-identity / save-identity / detect-identity（提交人身份，见 core/git-identity）。
 *
 * 同步范围是**文件集**（shared/sync-files.ts）：账本 + 账户库 + Excel 模板 + 受托管 .gitignore。
 * 编排：场景 A/B/C 首同步判别、push/pull 前置快照提交、fetch → analyzeMerge →
 * 逐文件三路合并（core/merge-engine）→ 两阶段落盘（全部校验通过才写）→ 合并提交 +
 * 索引重建，sync 域互斥（SYNCING，withWriteLock 外第二道闸）。
 *
 * 与 brief 的差异（Task 1/2 已确立的事实，本文件遵守）：
 * - URL 校验放行测试/E2E 通道 http://127.0.0.1:<port> / http://localhost:<port>（isomorphic-git 1.41.3
 *   无 file:// 本地传输，Task 1 起以进程内 smart-HTTP 服务器替代；GitHub https 为主通道）；
 * - 入参校验在 acquireSync 之前、try 之外 → 非法入参 reject（与 add-entry/save-file 同约定；
 *   brief 的 configure 非法入参测试即断言 rejects），且不占用/泄漏同步互斥；
 * - push/pull 的合并分支共用 applyRemoteMerge（DRY，语义不变）；
 * - M11 起冲突快照为**逐文件三路**（SyncFileConflict[]），取代扁平 base/ours/theirs。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConfigureSyncParams, ConfigureSyncResult, DetectIdentityResult, GitIdentityState, GitNetworkConfig, ResolveConflictParams, ResolveConflictResult, ResolveFileParam, SaveIdentityResult, SaveNetworkResult, SyncConfig, SyncResult, SyncStatus, TestConnectionParams, TestConnectionResult } from '../../../shared/ipc'
import { SYNC_ACCOUNTS_FILE, SYNC_GITIGNORE_FILE, SYNC_TEMPLATES_FILE } from '../../../shared/sync-files'
import type { DrizzleDb } from '../../db/index'
import { SYNC_BRANCH, type GitSync, type MergeStatus } from '../../core/git-sync'
import { normalizeGitNetwork } from '../../core/git-network'
import { describeIdentityError, fetchGitHubUser, resolveGitIdentity, validateManualIdentity } from '../../core/git-identity'
import { mergeTrackedFiles, parseAccountsFile, parseTemplatesFile, type MergePlan, type MergedFile } from '../../core/merge-engine'
import { refreshIndex } from '../../core/index-builder'
import { commitStagedLedger, stageLedgerChecked } from '../../utils/ledger-writer'
import { writeJsonChecked } from '../../utils/json-writer'
import type { PythonSvc } from '../../core/python-svc'
import type { IpcRegistrar } from '../ledger/ipc-handlers'
import type { GitIdentityStore } from '../../stores/git-identity-store'
import type { GitNetworkStore } from '../../stores/git-network-store'
import type { SyncConfigStore, TokenStore } from '../../stores/token-store'
import { withWriteLock } from '../../utils/write-lock'

export interface SyncDeps {
  db: DrizzleDb
  engine: PythonSvc
  ledgerPath: string
  tokens: TokenStore
  config: SyncConfigStore
  /** M12 本机网络配置（代理 + 超时）——机器级，与工作目录无关 */
  network: GitNetworkStore
  /** M13 提交人身份（手填机器级 + 识别缓存按工作目录隔离，见 stores/git-identity-store） */
  identity: GitIdentityStore
  git: GitSync
  /** 可注入时间源（lastSyncAt 测试） */
  now?: () => number
  /**
   * M13 GitHub API 根（仅测试/E2E 注入回环假服务器用；缺省官方 api.github.com）。
   * **绝不由渲染端控制**——否则等于给出一个「把 PAT 发到任意地址」的原语。
   */
  githubApiBaseUrl?: string
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

/**
 * resolve-conflict 入参形状校验（拒绝非法入参用，在 acquireSync/try 之外调用）。
 * path 必须 ∈ 受追踪文件集（天然防目录穿越）；「是否覆盖全部冲突文件」在拿到合并计划后再校验。
 */
function validateResolveParams(raw: unknown, allowed: readonly string[]): ResolveFileParam[] {
  const p = (raw ?? {}) as Partial<ResolveConflictParams>
  if (!Array.isArray(p.resolved) || p.resolved.length === 0) throw new Error('resolved 必须是非空数组')
  const allowedSet = new Set(allowed)
  const seen = new Set<string>()
  let bytes = 0
  const resolved: ResolveFileParam[] = p.resolved.map((item, idx) => {
    const r = (item ?? {}) as Partial<ResolveFileParam>
    if (typeof r.path !== 'string' || !allowedSet.has(r.path)) {
      throw new Error(`resolved[${idx}].path 必须是受追踪文件`)
    }
    if (seen.has(r.path)) throw new Error(`resolved 路径重复：${r.path}`)
    seen.add(r.path)
    if (r.content !== null && typeof r.content !== 'string') {
      throw new Error(`resolved[${idx}].content 必须是字符串或 null`)
    }
    bytes += Buffer.byteLength(r.content ?? '', 'utf8')
    return { path: r.path, content: r.content }
  })
  if (bytes > MAX_SYNC_CONTENT_BYTES) throw new Error('合并内容超过 20MB 上限')
  return resolved
}

/** 把 git 握手的失败翻成人话——「代理没配好」与「PAT 不对」在原始错误里长得一样，必须分开说 */
function describeConnectionError(err: unknown, network: GitNetworkConfig): string {
  const message = String(err).replace(/^Error:\s*/, '')
  if (message.includes('超时')) return message // withTimeout 的文案已含代理提示，直接用
  // isomorphic-git 的 HttpError.data 只有 { statusCode, statusMessage, response }（无 url/headers，无泄漏）
  const status = (err as { data?: { statusCode?: number } })?.data?.statusCode
  if (status === 401 || status === 403) return '网络已通，但认证失败：请检查 PAT 是否有效（需 repo scope）'
  if (status === 404) return '网络已通，但仓库不存在或无权访问：请检查仓库地址与 PAT 权限'
  if (typeof status === 'number' && status >= 500) {
    return network.proxyUrl
      ? `代理 ${network.proxyUrl} 返回 ${status}：代理未放行该站点，或代理节点不可用`
      : `远端返回 ${status}：请稍后重试`
  }
  // 代理软件没开 / 端口填错 → 连接被拒（最常见的一种填错）
  const code = (err as { code?: string })?.code
  if (network.proxyUrl && (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH')) {
    return `无法连接代理 ${network.proxyUrl}（${code}）：请确认代理软件已启动、端口与地址正确`
  }
  return network.proxyUrl ? `连接失败（当前代理 ${network.proxyUrl}）：${message}` : message
}

/**
 * M12 连接测试：用**已保存**的网络配置做一次真实 git 握手（listServerRefs）——一次同时验证
 * 代理、网络、仓库地址、PAT 四件事（比 ping 主机说明力强得多）。
 * 读配置不做任何写入，故不进 writeLock / SYNCING（不该被进行中的 push/pull 挡住）。
 */
async function testConnection(deps: SyncDeps, raw: unknown): Promise<TestConnectionResult> {
  const p = (raw ?? {}) as Partial<TestConnectionParams>
  const saved = deps.config.load()
  const repoUrl = typeof p.repoUrl === 'string' && p.repoUrl.trim() !== '' ? p.repoUrl.trim() : (saved?.repoUrl ?? '')
  if (repoUrl === '') return { ok: false, message: '请先填写并保存仓库地址' }
  if (!GITHUB_REPO_URL_RE.test(repoUrl) && !isLoopbackHttpUrl(repoUrl)) {
    return { ok: false, message: '仓库地址必须是 GitHub 仓库地址（https://github.com/owner/repo）' }
  }
  const network = deps.network.load()
  try {
    await deps.git.listServerRefs(repoUrl)
    return { ok: true, message: network.proxyUrl ? `连接成功（经代理 ${network.proxyUrl}）` : '连接成功（直连）' }
  } catch (err) {
    return { ok: false, message: describeConnectionError(err, network) }
  }
}

/**
 * M13 身份识别缓存的工作目录键来源——与 PAT 同域（token-store 的 workspaceStorageKey）。
 * 识别缓存按工作目录隔离，绝不能让上一个账本的 GitHub 身份漏到新账本（会挂错提交人）。
 */
const workspaceDirOf = (deps: SyncDeps): string => (deps.ledgerPath === '' ? '' : dirname(deps.ledgerPath))

/** 当前生效身份 + 存储原貌（`effective` 是推导值，渲染端只读展示；提交时主进程按同一函数求值） */
function buildIdentityState(deps: SyncDeps): GitIdentityState {
  const view = deps.identity.load(workspaceDirOf(deps))
  return { ...view, effective: resolveGitIdentity(view.manual, view.detected) }
}

/**
 * M13 识别 GitHub 身份并把结果缓存到该工作目录下。PAT 只在主进程（safeStorage）取用，不出主进程。
 * 读配置 + 一次 HTTP，不做同步内容写入，故不进 writeLock / SYNCING（不该被进行中的 push/pull 挡住）。
 */
async function detectIdentity(deps: SyncDeps): Promise<DetectIdentityResult> {
  const pat = deps.tokens.load()
  if (!pat) return { ok: false, message: '尚未保存访问令牌（PAT），请先配置同步后再识别' }
  const network = deps.network.load()
  try {
    const user = await fetchGitHubUser(pat, {
      network,
      ...(deps.githubApiBaseUrl === undefined ? {} : { baseUrl: deps.githubApiBaseUrl })
    })
    const at = new Date(deps.now ? deps.now() : Date.now()).toISOString()
    deps.identity.saveDetected(workspaceDirOf(deps), { login: user.login, id: user.id, name: user.name, at })
    return { ok: true, message: `已识别 GitHub 身份：${user.login}`, state: buildIdentityState(deps) }
  } catch (err) {
    return { ok: false, message: describeIdentityError(err, network) }
  }
}

/**
 * `sync:configure` 成功后顺带做一次 best-effort 识别（用户口径「没配置时就用二」→ 首次配置零额外操作）。
 * **只在真 GitHub 远端上做**：单测/E2E 的远端都是回环地址，跳过可保证测试零外连、零拖慢。
 * 在 writeLock **之外**调用——锁内做网络探测会把账本保存排队，且 SYNCING 期间会让渲染端误报
 * 「同步进行中，请稍候」；失败静默，识别不成绝不能影响 configure 的结果。
 */
function detectIdentityInBackground(deps: SyncDeps): void {
  void detectIdentity(deps).catch(() => undefined)
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

/** push/pull 前置：先把追踪文件集纳管进索引，再判脏 → 快照提交（保存后自动触发，此时必有未提交改动） */
async function snapshotLocal(deps: SyncDeps): Promise<void> {
  await deps.git.addTrackedFiles()
  if (await deps.git.hasUncommitted()) {
    await deps.git.commit(`save: ${new Date().toISOString()}`)
  }
}

/** 合并提交（双亲 [HEAD, 远端]——真实 git 合并语义，第一父=本地）。
 * isomorphic-git 的显式 parent 整体替换默认 [HEAD]，只传远端会让本地历史游离（T3 审查修复）；
 * 单亲提交还会被 push 客户端快进检查拒绝（远端 ref 非祖先）。fetch 已保证远端 ref 存在。 */
async function mergeCommit(deps: SyncDeps, message: string): Promise<string> {
  return deps.git.commit(message, [await deps.git.headOid(), await deps.git.remoteHeadOid()])
}

/** JSON 追踪文件的结构化校验（与合并引擎共用同一份解析规则） */
function validateJsonContent(path: string, content: string): void {
  if (path === SYNC_ACCOUNTS_FILE) parseAccountsFile(content)
  else if (path === SYNC_TEMPLATES_FILE) parseTemplatesFile(content)
  else throw new Error(`未知的 JSON 追踪文件：${path}`)
}

const ledgerNameOf = (deps: SyncDeps): string => basename(deps.ledgerPath)
const writeContentOf = (file: MergedFile): string => (file.outcome.kind === 'write' ? file.outcome.content : '')

/**
 * 两阶段落盘（M11 多文件合并的关键）：
 * 阶段 1 全部只读校验（账本写 tmp + Python parse_entries，JSON 解析 + 结构化校验），
 * 任一失败 → 删 tmp、原文件与索引零改动；阶段 2 才统一替换/删除。
 * 否则账本校验失败时 JSON 已经写坏——半写状态比不写更糟。
 */
async function applyMergePlan(deps: SyncDeps, plan: MergePlan): Promise<{ ok: boolean; message?: string }> {
  const ledgerName = ledgerNameOf(deps)
  const writes = plan.files.filter((f) => f.outcome.kind === 'write')
  const deletes = plan.files.filter((f) => f.outcome.kind === 'delete')

  for (const file of writes) {
    if (file.path === ledgerName) {
      const staged = await stageLedgerChecked(deps, writeContentOf(file))
      if (!staged.ok) return { ok: false, message: staged.message ?? '账本校验失败' }
      continue
    }
    try {
      validateJsonContent(file.path, writeContentOf(file))
    } catch (err) {
      rmSync(`${deps.ledgerPath}.tmp`, { force: true }) // 清理已 staged 的账本 tmp
      return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
    }
  }

  for (const file of writes) {
    if (file.path === ledgerName) {
      commitStagedLedger(deps.ledgerPath)
      continue
    }
    const result = writeJsonChecked(join(dirname(deps.ledgerPath), file.path), writeContentOf(file), (text) =>
      validateJsonContent(file.path, text)
    )
    if (!result.ok) return result
  }
  for (const file of deletes) {
    rmSync(join(dirname(deps.ledgerPath), file.path), { force: true })
  }
  return { ok: true }
}

function conflictResult(plan: MergePlan): SyncResult {
  return { ok: false, conflict: true, conflicts: plan.conflicts }
}

/**
 * push/pull 共用合并分支（DRY）：
 * 逐文件三路合并 → 有冲突即返回快照（工作区不动）→ 否则两阶段落盘 → 双亲合并提交
 * →（doPush 时）push（adopted=场景 C 接管 → force）→ 索引重建。
 * pull 只拉不推（doPush=false）：只读 PAT 不失败、不静默发布本地改动（T3 审查修复）。
 */
async function applyRemoteMerge(deps: SyncDeps, config: SyncConfig, status: Extract<MergeStatus, { kind: 'merge' }>, doPush: boolean): Promise<SyncResult> {
  const plan = mergeTrackedFiles(status.files, ledgerNameOf(deps))
  if (plan.hasConflict) {
    markFailed(deps, config, '同步冲突：需要人工合并')
    return conflictResult(plan)
  }
  const applied = await applyMergePlan(deps, plan)
  if (!applied.ok) {
    markFailed(deps, config, applied.message ?? '合并结果校验失败')
    return { ok: false, message: applied.message }
  }
  await deps.git.addTrackedFiles()
  await mergeCommit(deps, status.fastForward ? 'merge: 快进合并' : 'merge: 自动合并')
  if (doPush) await deps.git.push(config.adopted ?? false)
  await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
  markSynced(deps, config)
  return { ok: true }
}

export function registerSyncHandlers(ipc: IpcRegistrar, deps: SyncDeps): void {
  ipc.handle('sync:get-status', (): SyncStatus => toStatus(deps.config.load()))

  ipc.handle('sync:clear', (): { ok: boolean } => {
    deps.tokens.clear()
    deps.config.clear()
    // M13：识别缓存是该目录 PAT 的派生物，PAT 一清就该一起清（否则提交仍挂着已撤销 PAT 换来的身份）。
    // 手填的提交人是**机器级**设置，不随某个工作目录的同步配置一起清（弹窗里有说明）。
    deps.identity.saveDetected(workspaceDirOf(deps), null)
    return { ok: true }
  })

  // M12 网络配置三通道（代理 + 超时）。机器级配置，与工作目录/账本仓库无关，故不参与 sync:clear。
  ipc.handle('sync:get-network', (): GitNetworkConfig => deps.network.load())

  ipc.handle('sync:save-network', (_event: unknown, raw: unknown): SaveNetworkResult => {
    // 非法地址不让保存（返回 ok:false 而非 reject——表单要就地回显错在哪，如「需带端口」）
    try {
      const network = normalizeGitNetwork(raw)
      deps.network.save(network)
      return { ok: true, network }
    } catch (err) {
      return { ok: false, error: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipc.handle('sync:test-connection', (_event: unknown, raw: unknown): Promise<TestConnectionResult> =>
    testConnection(deps, raw))

  // M13 提交人身份三通道。手填值机器级；识别缓存按工作目录隔离（见 stores/git-identity-store）。
  // detect 不收任何参数——API 根只由主进程 deps 注入，防止渲染端把 PAT 指到任意地址。
  ipc.handle('sync:get-identity', (): GitIdentityState => buildIdentityState(deps))

  ipc.handle('sync:save-identity', (_event: unknown, raw: unknown): SaveIdentityResult => {
    // 非法/半填不让保存（返回 ok:false 而非 reject——表单要就地回显，如「姓名与邮箱要一起填」）
    try {
      const manual = validateManualIdentity(raw)
      deps.identity.saveManual(manual)
      return { ok: true, state: buildIdentityState(deps) }
    } catch (err) {
      return { ok: false, error: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipc.handle('sync:detect-identity', (): Promise<DetectIdentityResult> => detectIdentity(deps))

  ipc.handle('sync:configure', async (_event: unknown, raw: unknown): Promise<ConfigureSyncResult> => {
    const result = await withWriteLock(async (): Promise<ConfigureSyncResult> => {
      // 入参校验在 acquireSync/try 之外：非法入参 reject（与 add-entry/save-file 同约定），且不占用互斥
      const { repoUrl, pat } = validateConfigureParams(raw)
      acquireSync()
      try {
        deps.tokens.save(pat) // safeStorage 失败 → throw（配置零写入）

        // 连接测试 + 场景判别：refs 非空 → 远端已有内容
        const refs = await deps.git.listServerRefs(repoUrl)
        const hasRemote = refs.some((r) => r.ref === `refs/heads/${SYNC_BRANCH}`)
        // 本地已有内容判据 = 任一「内容文件」（账本/账户库/模板）非空。含账户库是关键：
        // 只判账本会让「账本为空但账户库已配置」的目录被 clone 覆盖（M11 修复）。
        const hasLocal = deps.git.trackedFiles
          .filter((f) => f !== SYNC_GITIGNORE_FILE)
          .some((f) => {
            const text = readLocalText(deps, f)
            return text !== null && text !== ''
          })

        let config: SyncConfig = { repoUrl, branch: SYNC_BRANCH, adopted: false }
        if (!hasRemote) {
          // 场景 A：空仓 → init → 纳管/提交 → remote → push -u
          if (!(await deps.git.isRepo())) await deps.git.initRepo()
          await deps.git.addTrackedFiles()
          if (await deps.git.hasUncommitted()) await deps.git.commit('init: 首次同步')
          await deps.git.addRemote(repoUrl)
          await deps.git.push()
        } else if (!hasLocal) {
          // 场景 B：本地无内容 → clone 到账本目录
          await deps.git.clone(repoUrl)
          // clone 只落文件、索引仍 missing——首同步用户须立即可见明细（M6 终审修复 I-1）
          // 另补托管 .gitignore / 纳管（远端可能是旧版本推的，没有忽略规则与账户库）
          await deps.git.addTrackedFiles()
          if (await deps.git.hasUncommitted()) await deps.git.commit('init: 首次同步（clone）')
          await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
        } else {
          // 场景 C：两端都有 → init + 纳管/提交 + remote + fetch → analyzeMerge 判别
          config.adopted = true // unrelated histories 接管 → 后续 push 需 force
          if (!(await deps.git.isRepo())) await deps.git.initRepo()
          await deps.git.addTrackedFiles()
          if (await deps.git.hasUncommitted()) await deps.git.commit('init: 首次同步')
          await deps.git.addRemote(repoUrl)
          await deps.git.fetch()
          const status = await deps.git.analyzeMerge()
          if (status.kind === 'merge') {
            const merged = await applyRemoteMerge(deps, config, status, true)
            if (!merged.ok) {
              // 内嵌 status 传 syncing=false（返回时 finally 未执行，SYNCING.current 仍为 true——T3 审查修复）
              return {
                ok: false,
                conflict: merged.conflict,
                conflicts: merged.conflicts,
                error: merged.message,
                status: toStatus(config, false)
              }
            }
          } else {
            // up-to-date / local-ahead：远端未被本地领先的内容覆盖 → force push 接管
            // （unrelated histories 非快进会被远端拒绝）
            await deps.git.push(true)
          }
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
    })
    // M13：首次配置顺带识别一次 GitHub 身份（best-effort、**锁外**、失败静默）。
    // 只对**真 GitHub 远端**做——单测/E2E 的远端是回环地址，跳过保证测试零外连、零拖慢。
    const repoUrl = deps.config.load()?.repoUrl ?? ''
    if (result.ok && GITHUB_REPO_URL_RE.test(repoUrl)) detectIdentityInBackground(deps)
    return result
  })

  ipc.handle('sync:push', (): Promise<SyncResult> =>
    withWriteLock(async () => {
      acquireSync()
      try {
        // 本地 commit 始终执行（纯本地模式也保留版本历史）；远端操作仅配置后触发
        await snapshotLocal(deps)
        const config = deps.config.load()
        if (!config || !deps.tokens.load()) {
          return { ok: true, message: '已保存到本地 Git' }
        }
        await deps.git.fetch()
        const status = await deps.git.analyzeMerge()
        if (status.kind === 'up-to-date') { markSynced(deps, config); return { ok: true } }
        if (status.kind === 'local-ahead') {
          await deps.git.push(config.adopted ?? false)
          markSynced(deps, config)
          return { ok: true }
        }
        return applyRemoteMerge(deps, config, status, true)
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
        return applyRemoteMerge(deps, config, status, false)
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
      const resolved = validateResolveParams(raw, deps.git.trackedFiles)
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
        // oids 未变 ⇒ 重算的计划与冲突时逐字节相同，可安全用渲染端决议覆盖对应文件
        const status = await deps.git.analyzeMerge()
        if (status.kind !== 'merge') {
          markSynced(deps, config) // 远端已与本地一致（如对方采用了我方内容）
          return { ok: true }
        }
        const ledgerName = ledgerNameOf(deps)
        const plan = mergeTrackedFiles(status.files, ledgerName)
        const conflictPaths = plan.conflicts.map((c) => c.path)
        const givenPaths = new Set(resolved.map((r) => r.path))
        // 覆盖性校验：既不能漏（用未处理内容提交），也不能多（用陈旧/越权路径覆写未冲突文件）
        const missing = conflictPaths.filter((p) => !givenPaths.has(p))
        if (missing.length > 0) {
          return { ok: false, message: `未处理的冲突文件：${missing.join('、')}` }
        }
        const extra = resolved.filter((r) => !conflictPaths.includes(r.path))
        if (extra.length > 0) {
          return { ok: false, message: `以下文件并非冲突文件，不能在此覆写：${extra.map((r) => r.path).join('、')}` }
        }
        // 账本是产品主文件：删除决议一律拒绝（防非法入参清空账本）
        if (resolved.some((r) => r.path === ledgerName && r.content === null)) {
          return { ok: false, message: '账本文件不能被删除' }
        }
        const byPath = new Map(resolved.map((r) => [r.path, r] as const))
        const finalPlan: MergePlan = {
          files: plan.files.map((file) => {
            const decision = byPath.get(file.path)
            if (!decision) return file // 非冲突文件沿用三路推导结果
            return decision.content === null
              ? { ...file, outcome: { kind: 'delete' } }
              : { ...file, outcome: { kind: 'write', content: decision.content } }
          }),
          hasConflict: false,
          conflicts: []
        }
        const applied = await applyMergePlan(deps, finalPlan)
        if (!applied.ok) {
          markFailed(deps, config, applied.message ?? '合并结果校验失败') // 与 push/pull 分支一致（T3 审查修复）
          return { ok: false, message: applied.message }
        }
        await deps.git.addTrackedFiles()
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

/** 读工作区内某追踪文件（不存在 → null） */
function readLocalText(deps: SyncDeps, filepath: string): string | null {
  const path = join(dirname(deps.ledgerPath), filepath)
  if (!existsSync(path)) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}
