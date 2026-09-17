import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzle, openDatabase } from '../../db/index'
import { GitSync, GIT_AUTHOR, SYNC_BRANCH } from '../../core/git-sync'
import { createBareRepo, readRemoteFile, remoteCommitCount, seedRemote, seedRemoteInit, startGitServer } from '../../utils/test-servers/git-test-server'
import { SYNC_ACCOUNTS_FILE, SYNC_GITIGNORE_FILE } from '../../../shared/sync-files'
import { getLedgerStatus } from '../../core/index-builder'
import { registerSyncHandlers } from './ipc-handlers-sync'
import type { IpcRegistrar } from '../ledger/ipc-handlers'
import type { ConfigureSyncResult, DetectedGitIdentity, GitIdentityManual, GitIdentityState, GitNetworkConfig, SaveIdentityResult, SaveNetworkResult, SyncConfig, SyncResult, TestConnectionResult } from '../../../shared/ipc'
import { PythonSvc } from '../../core/python-svc'
import { normalizeGitNetwork } from '../../core/git-network'
import { resolveGitIdentity } from '../../core/git-identity'
import type { GitNetworkStore } from '../../stores/git-network-store'
import type { GitIdentityStore } from '../../stores/git-identity-store'
import type { SyncConfigStore, TokenStore } from '../../stores/token-store'
import { FAKE_GITHUB_USER, startFakeGitHub, type FakeGitHub } from '../../utils/test-servers/fake-github-server'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'

const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')
const FIXED_NOW = 1_758_000_000_000

/** 内存 TokenStore（CI 无 safeStorage） */
class InMemoryTokenStore implements TokenStore {
  private pat: string | null = null
  load() { return this.pat }
  save(pat: string) { this.pat = pat }
  clear() { this.pat = null }
}
class InMemoryConfigStore implements SyncConfigStore {
  private cfg: SyncConfig | null = null
  load() { return this.cfg }
  save(c: SyncConfig) { this.cfg = c }
  clear() { this.cfg = null }
}
/** 内存 GitNetworkStore（M12 机器级网络配置；CI 无 electron-store） */
class InMemoryNetworkStore implements GitNetworkStore {
  private cfg = normalizeGitNetwork(null)
  load() { return this.cfg }
  save(c: GitNetworkConfig) { this.cfg = normalizeGitNetwork(c) }
}
/** 内存 GitIdentityStore（M13；CI 无 electron-store）。手填值机器级 + 识别缓存按工作目录键隔离，
 *  与 ElectronGitIdentityStore 同语义（store 侧用 resolve().toLowerCase()） */
class InMemoryIdentityStore implements GitIdentityStore {
  private manual: GitIdentityManual | null = null
  private readonly detected = new Map<string, DetectedGitIdentity>()
  private keyOf(workspaceDir: string) { return resolve(workspaceDir).toLowerCase() }
  load(workspaceDir: string) {
    return { manual: this.manual, detected: this.detected.get(this.keyOf(workspaceDir)) ?? null }
  }
  saveManual(manual: GitIdentityManual | null) { this.manual = manual }
  saveDetected(workspaceDir: string, detected: DetectedGitIdentity | null) {
    if (detected === null) this.detected.delete(this.keyOf(workspaceDir))
    else this.detected.set(this.keyOf(workspaceDir), detected)
  }
}

describe('sync handlers（M6）', () => {
  let db: ReturnType<typeof createDrizzle>
  let engine: PythonSvc
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let workDir: string
  let ledgerPath: string
  let bareDir: string
  let server: { url: string; close: () => Promise<void> } | null = null

  /** 新建本地裸仓 + 进程内 smart-HTTP 服务器，返回远端 URL（brief 的 pathToFileURL 在 1.41.3 不可用） */
  async function newRepo(): Promise<string> {
    bareDir = await createBareRepo()
    server = await startGitServer(bareDir)
    return server.url
  }

  async function setup(opts: { seed?: string; withLocal?: boolean; githubApiBaseUrl?: string } = {}): Promise<{ tokens: TokenStore; config: SyncConfigStore; network: InMemoryNetworkStore; identity: InMemoryIdentityStore }> {
    workDir = mkdtempSync(join(tmpdir(), 'beanwise-synch-'))
    ledgerPath = join(workDir, 'main.beancount')
    if (opts.withLocal !== false) copyFileSync(FIXTURE, ledgerPath)
    const tokens: TokenStore = new InMemoryTokenStore()
    const config: SyncConfigStore = new InMemoryConfigStore()
    const network = new InMemoryNetworkStore()
    const identity = new InMemoryIdentityStore()
    const identityOf = () => {
      const view = identity.load(workDir)
      return resolveGitIdentity(view.manual, view.detected)
    }
    const gitSync = new GitSync({
      ledgerPath,
      auth: () => ({ username: 'x-access-token', password: tokens.load() ?? '' }),
      network: () => network.load(),
      identity: identityOf
    })
    const ipc: IpcRegistrar = { handle: (c, l) => { handlers[c] = l as (...args: unknown[]) => unknown } }
    handlers = {}
    registerSyncHandlers(ipc, {
      db, engine, ledgerPath, tokens, config, network, identity, git: gitSync,
      now: () => FIXED_NOW,
      ...(opts.githubApiBaseUrl === undefined ? {} : { githubApiBaseUrl: opts.githubApiBaseUrl })
    })
    if (opts.seed) await seedRemote(server!.url, opts.seed)
    return { tokens, config, network, identity }
  }

  afterEach(async () => {
    if (server) await server.close()
    server = null
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    if (bareDir) rmSync(bareDir, { recursive: true, force: true })
    workDir = ''
    bareDir = ''
  })

  beforeAll(async () => {
    db = createDrizzle(openDatabase(':memory:'))
    engine = new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] })
    await engine.start()
  })
  afterAll(async () => { await engine.stop(); db.$client.close() })

  it('sync:get-status 未配置 → configured:false', async () => {
    await setup()
    expect(await handlers['sync:get-status']()).toEqual({ configured: false, lastSyncAt: null, lastError: null, syncing: false })
  })

  it('sync:configure 场景 A：空仓 → init+push，裸仓可见', async () => {
    const url = await newRepo()
    await setup()
    const r = await handlers['sync:configure']({}, { repoUrl: url, pat: 'test-pat' })
    // http://127.0.0.1:<port> 本地 URL 由 validateConfigureParams 放行（测试/E2E 通道，见 Global Constraints）
    expect(r).toMatchObject({ ok: true })
    expect(await readRemoteFile(bareDir)).toBe(readFileSync(ledgerPath, 'utf8'))
    expect(handlers['sync:get-status']()).toMatchObject({ configured: true, lastSyncAt: FIXED_NOW, lastError: null })
  }, 30_000)

  it('sync:configure 场景 B：本地无账本 → clone', async () => {
    const url = await newRepo()
    // 远端先有内容（fixture + 追加一笔）
    await seedRemoteInit(url,
      readFileSync(FIXTURE, 'utf8') +
      '\n2026-08-09 * "远端" "配置测试"\n  Expenses:Food  3.00 CNY\n  Assets:Bank:CNB  -3.00 CNY\n')
    await setup({ withLocal: false })
    const r = await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    expect(r).toMatchObject({ ok: true })
    expect(readFileSync(ledgerPath, 'utf8')).toContain('配置测试')
    // M6 终审修复 I-1：clone 后索引已重建（首同步用户立即可见明细，非 missing）
    const index = getLedgerStatus(db)
    expect(index?.status).toBe('ok')
    expect(index?.entryCount).toBeGreaterThan(0)
  }, 30_000)

  it('sync:configure 场景 C 一致：直接接管', async () => {
    const url = await newRepo()
    // 远端内容 = fixture 内容（先复制再 push）
    const workDir2 = mkdtempSync(join(tmpdir(), 'beanwise-remote-'))
    try {
      await git.init({ fs, dir: workDir2, defaultBranch: SYNC_BRANCH })
      copyFileSync(FIXTURE, join(workDir2, 'main.beancount'))
      await git.add({ fs, dir: workDir2, filepath: 'main.beancount' })
      await git.commit({ fs, dir: workDir2, message: 'init', author: GIT_AUTHOR, ref: SYNC_BRANCH })
      await git.addRemote({ fs, dir: workDir2, remote: 'origin', url })
      await git.push({ fs, http, dir: workDir2, remote: 'origin', ref: SYNC_BRANCH })
    } finally { rmSync(workDir2, { recursive: true, force: true }) }
    await setup()
    const r = await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    expect(r).toMatchObject({ ok: true })
  }, 30_000)

  it('sync:configure 场景 C 不一致：conflict 逐文件三路快照（账本 base=null）', async () => {
    const url = await newRepo()
    // 远端初始 = 本地 fixture 内容（一致），再追加一笔（→ 与本地不一致）
    await seedRemoteInit(url, readFileSync(FIXTURE, 'utf8'))
    await seedRemote(url, '\n2026-08-09 * "远端独有" "接管"\n  Expenses:Food  2.00 CNY\n  Assets:Bank:CNB  -2.00 CNY\n')
    await setup()
    const r = (await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })) as ConfigureSyncResult
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    // M11：冲突载荷为逐文件三态（unrelated histories → 账本无共同祖先，base 为 null）
    const ledger = r.conflicts?.find((c) => c.path === 'main.beancount')
    expect(ledger?.base).toBeNull()
    expect(ledger?.ours).toContain('Breakfast')
    expect(ledger?.theirs).toContain('远端独有')
  }, 30_000)

  it('sync:configure 非法入参拒绝（URL 格式 / PAT 空）', async () => {
    await setup()
    await expect(handlers['sync:configure']({}, { repoUrl: 'ftp://x', pat: 'p' })).rejects.toThrow()
    await expect(handlers['sync:configure']({}, { repoUrl: 'https://github.com/a/b', pat: '' })).rejects.toThrow()
    await expect(handlers['sync:configure']({}, { repoUrl: 'https://github.com/a/b', pat: 'x'.repeat(201) })).rejects.toThrow()
  })

  it('sync:push 快进：配置后本地追加 → push → 裸仓可见 + lastSyncAt 更新', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    appendFileSync(ledgerPath, '\n2026-08-09 * "本地追加" "快进"\n  Expenses:Food  9.00 CNY\n  Assets:Bank:CNB  -9.00 CNY\n')
    const r = (await handlers['sync:push']()) as SyncResult
    expect(r).toMatchObject({ ok: true })
    expect(await readRemoteFile(bareDir)).toContain('本地追加')
  }, 30_000)

  it('sync:push 分叉 clean-merge：两端追加 → 自动合并落盘 + push', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    await seedRemote(url, '\n2026-08-09 * "远端追加" "自动合并"\n  Expenses:Food  4.00 CNY\n  Assets:Bank:CNB  -4.00 CNY\n')
    // 本地在 Breakfast 交易前插入（与远端 EOF 追加不重叠 → diff3 干净合并；
    // 注意：diff3 对「同一位置的两处追加」判冲突，故本地改位置插入——与 git-sync.test.ts 同裁定）
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8')
      .replace('\n2026-01-02 * "Breakfast"',
        '\n2026-08-09 * "本地追加" "自动合并"\n  Expenses:Food  7.00 CNY\n  Assets:Bank:CNB  -7.00 CNY\n\n2026-01-02 * "Breakfast"'))
    const r = (await handlers['sync:push']()) as SyncResult
    expect(r).toMatchObject({ ok: true })
    const remote = await readRemoteFile(bareDir)
    expect(remote).toContain('远端追加')
    expect(remote).toContain('本地追加')
    expect(readFileSync(ledgerPath, 'utf8')).toContain('远端追加') // 本地文件 = 合并结果
  }, 30_000)

  it('sync:push 冲突：同一行不同修改 → conflict 三路快照，文件不动', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    // 远端改行
    const seedDir = mkdtempSync(join(tmpdir(), 'beanwise-seed-'))
    try {
      await git.clone({ fs, http, dir: seedDir, url, ref: SYNC_BRANCH, singleBranch: true })
      const p = join(seedDir, 'main.beancount')
      writeFileSync(p, readFileSync(p, 'utf8').replace('* "Breakfast"', '* "Breakfast-Remote"'))
      await git.add({ fs, dir: seedDir, filepath: 'main.beancount' })
      await git.commit({ fs, dir: seedDir, message: 'seed', author: GIT_AUTHOR, ref: SYNC_BRANCH })
      await git.push({ fs, http, dir: seedDir, remote: 'origin', ref: SYNC_BRANCH })
    } finally { rmSync(seedDir, { recursive: true, force: true }) }
    // 本地也改同一行（直接写文件——等效编辑器保存后未 commit 的状态）
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('* "Breakfast"', '* "Breakfast-Local"'))
    const before = readFileSync(ledgerPath, 'utf8')
    const r = (await handlers['sync:push']()) as SyncResult
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    const ledger = r.conflicts?.find((c) => c.path === 'main.beancount')
    expect(ledger?.ours).toContain('Breakfast-Local')
    expect(ledger?.theirs).toContain('Breakfast-Remote')
    expect(ledger?.base).toContain('Breakfast')
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before) // 冲突不落盘
  }, 30_000)

  it('sync:pull 快进：远端新增 → pull → 文件更新（索引联动在 E2E 验证）', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    await seedRemote(url, '\n2026-08-09 * "远端拉取" "快进"\n  Expenses:Food  6.00 CNY\n  Assets:Bank:CNB  -6.00 CNY\n')
    const r = (await handlers['sync:pull']()) as SyncResult
    expect(r).toMatchObject({ ok: true })
    expect(readFileSync(ledgerPath, 'utf8')).toContain('远端拉取')
    // 索引联动：handler 内 refreshIndex 已执行（文件已落盘）；明细可见性由 E2E Task 7 Step 4 断言
  }, 30_000)

  it('sync:resolve-conflict：采用远端 → 落盘 + push + 裸仓为最终内容', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    // 远端改同一行制造冲突（与 push 冲突用例同型；brief 原案的「远端 EOF 追加 + 本地改行」
    // 是不同区域 → diff3 干净合并不会触发冲突，故对齐为同行修改）
    const seedDir = mkdtempSync(join(tmpdir(), 'beanwise-seed-'))
    try {
      await git.clone({ fs, http, dir: seedDir, url, ref: SYNC_BRANCH, singleBranch: true })
      const p = join(seedDir, 'main.beancount')
      writeFileSync(p, readFileSync(p, 'utf8').replace('* "Breakfast"', '* "Breakfast-Remote"'))
      await git.add({ fs, dir: seedDir, filepath: 'main.beancount' })
      await git.commit({ fs, dir: seedDir, message: 'seed', author: GIT_AUTHOR, ref: SYNC_BRANCH })
      await git.push({ fs, http, dir: seedDir, remote: 'origin', ref: SYNC_BRANCH })
    } finally { rmSync(seedDir, { recursive: true, force: true }) }
    // 本地也改同一行制造冲突
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('* "Breakfast"', '* "Breakfast-Local"'))
    await handlers['sync:push']()
    const conflict = (await handlers['sync:get-status']()) as { lastError: string | null }
    expect(conflict.lastError).toBeTruthy()
    // 手动解决：保留本地改行 + 追加一笔（合并内容任意合法 beancount）
    const merged = readFileSync(ledgerPath, 'utf8') + '\n2026-08-09 * "远端独有" "冲突解决"\n  Expenses:Food  2.00 CNY\n  Assets:Bank:CNB  -2.00 CNY\n'
    const r = (await handlers['sync:resolve-conflict']({}, { resolved: [{ path: 'main.beancount', content: merged }] })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await readRemoteFile(bareDir)).toBe(merged)
  }, 30_000)

  it('sync:resolve-conflict 校验失败：借贷不平 → ok:false + 文件不变', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    // 先制造真冲突（同行修改），否则 resolve 无可解决的冲突
    const remoteLedger = (await readRemoteFile(bareDir))!.replace('* "Breakfast"', '* "Breakfast-Remote"')
    await seedRemote(url, { 'main.beancount': remoteLedger })
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('* "Breakfast"', '* "Breakfast-Local"'))
    const pushed = (await handlers['sync:push']()) as SyncResult
    expect(pushed.conflict).toBe(true)

    const before = readFileSync(ledgerPath, 'utf8')
    const bad = '2026-08-09 * "坏" "内容"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -9.00 CNY\n'
    const r = (await handlers['sync:resolve-conflict']({}, { resolved: [{ path: 'main.beancount', content: bad }] })) as { ok: boolean; message?: string }
    expect(r.ok).toBe(false)
    expect(r.message).toBeTruthy()
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)
  }, 30_000)

  it('sync:resolve-conflict 远端推进：快照过期 → 拒绝，不写盘不推送', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    const seedDir = mkdtempSync(join(tmpdir(), 'beanwise-seed-'))
    try {
      // phase 1：远端改同一行制造冲突（同 resolve 用例）
      await git.clone({ fs, http, dir: seedDir, url, ref: SYNC_BRANCH, singleBranch: true })
      const p = join(seedDir, 'main.beancount')
      writeFileSync(p, readFileSync(p, 'utf8').replace('* "Breakfast"', '* "Breakfast-Remote"'))
      await git.add({ fs, dir: seedDir, filepath: 'main.beancount' })
      await git.commit({ fs, dir: seedDir, message: 'seed', author: GIT_AUTHOR, ref: SYNC_BRANCH })
      await git.push({ fs, http, dir: seedDir, remote: 'origin', ref: SYNC_BRANCH })
      // 本地也改同一行 → push 得冲突快照（fetch 时远端仍为 Breakfast-Remote）
      writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('* "Breakfast"', '* "Breakfast-Local"'))
      const pushR = (await handlers['sync:push']()) as SyncResult
      expect(pushR.ok).toBe(false)
      expect(pushR.conflict).toBe(true)
      // phase 2：远端在冲突 fetch 之后再推进一笔（冲突快照过期）
      writeFileSync(p, readFileSync(p, 'utf8') + '\n2026-08-09 * "远端推进" "冲突后"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
      await git.add({ fs, dir: seedDir, filepath: 'main.beancount' })
      await git.commit({ fs, dir: seedDir, message: 'advance', author: GIT_AUTHOR, ref: SYNC_BRANCH })
      await git.push({ fs, http, dir: seedDir, remote: 'origin', ref: SYNC_BRANCH })
    } finally { rmSync(seedDir, { recursive: true, force: true }) }
    // resolve：re-fetch 发现远端已推进 → ok:false，文件不动、远端不被 force push 覆盖
    const before = readFileSync(ledgerPath, 'utf8')
    const merged = before + '\n2026-08-09 * "解决" "内容"\n  Expenses:Food  5.00 CNY\n  Assets:Bank:CNB  -5.00 CNY\n'
    const r = (await handlers['sync:resolve-conflict']({}, { resolved: [{ path: 'main.beancount', content: merged }] })) as SyncResult
    expect(r.ok).toBe(false)
    expect(r.message).toContain('远端已有新变更')
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)
    expect(await readRemoteFile(bareDir)).not.toContain('解决')
  }, 30_000)

  // ---- M11：多文件同步（账户库 / Excel 模板随账本一起提交） ----

  /** 账户库文件文本（结构对齐 JsonAccountConfigStore.save） */
  const accountsJson = (...entries: Array<{ id: number; name: string; value: string }>): string =>
    JSON.stringify({ accounts: entries.map((e) => ({ ...e, description: '' })) }, null, 2)
  const seedLocal = (relPath: string, content: string): void => {
    const full = join(workDir, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  const localText = (relPath: string): string => readFileSync(join(workDir, relPath), 'utf8')

  it('账户库随账本一起同步：本地已有账户库 → 配置空仓即推送到裸仓', async () => {
    const url = await newRepo()
    await setup()
    seedLocal(SYNC_ACCOUNTS_FILE, accountsJson({ id: 1, name: '餐饮', value: 'Expenses:Food' }))
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    expect(await readRemoteFile(bareDir, SYNC_ACCOUNTS_FILE)).toContain('Expenses:Food')
    expect(await readRemoteFile(bareDir, SYNC_GITIGNORE_FILE)).toContain('.beanwise/index.db')
    // 本地缓存/元数据不进仓库
    seedLocal('.beanwise/index.db', 'binary')
    seedLocal('.beanwise/sync-config.json', '{"repoUrl":"x"}')
    await handlers['sync:push']()
    expect(await readRemoteFile(bareDir, '.beanwise/index.db')).toBeNull()
    expect(await readRemoteFile(bareDir, '.beanwise/sync-config.json')).toBeNull()
  }, 30_000)

  it('场景 B 收窄：账本为空但账户库非空 → 不 clone（改走合并，避免本地账户库被覆盖）', async () => {
    const url = await newRepo()
    await seedRemoteInit(url, {
      'main.beancount': readFileSync(FIXTURE, 'utf8'),
      [SYNC_ACCOUNTS_FILE]: accountsJson({ id: 1, name: '房租', value: 'Expenses:Rent' })
    })
    await setup() // 本地也存在账本 → 走场景 C；下面把账本清空、只留账户库，模拟「新机器已建账户库」
    rmSync(ledgerPath, { force: true })
    writeFileSync(ledgerPath, '', 'utf8')
    seedLocal(SYNC_ACCOUNTS_FILE, accountsJson({ id: 1, name: '餐饮', value: 'Expenses:Food' }))

    const r = (await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })) as ConfigureSyncResult
    expect(r.ok).toBe(true)
    // 账本从远端纳入，账户库为两侧并集（本地未被 clone 覆盖）
    expect(readFileSync(ledgerPath, 'utf8')).toContain('Breakfast')
    const accounts = localText(SYNC_ACCOUNTS_FILE)
    expect(accounts).toContain('Expenses:Food')
    expect(accounts).toContain('Expenses:Rent')
  }, 30_000)

  it('多文件冲突：账本 + 账户库同时冲突 → 逐文件快照；resolve 一次提交全部', async () => {
    const url = await newRepo()
    await setup()
    seedLocal(SYNC_ACCOUNTS_FILE, accountsJson({ id: 1, name: '餐饮', value: 'Expenses:Food' }))
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })

    // 远端：改账本同行 + 改同一账户（与本地冲突）
    const remoteLedger = (await readRemoteFile(bareDir))!.replace('* "Breakfast"', '* "Breakfast-Remote"')
    await seedRemote(url, {
      'main.beancount': remoteLedger,
      [SYNC_ACCOUNTS_FILE]: accountsJson({ id: 1, name: '餐费', value: 'Expenses:Food' })
    })
    // 本地：改账本同行 + 改同一账户（不同内容）
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('* "Breakfast"', '* "Breakfast-Local"'))
    seedLocal(SYNC_ACCOUNTS_FILE, accountsJson({ id: 1, name: '吃饭', value: 'Expenses:Food' }))

    const pushed = (await handlers['sync:push']()) as SyncResult
    expect(pushed.ok).toBe(false)
    expect(pushed.conflicts?.map((c) => c.path).sort()).toEqual(['.beanwise/accounts.json', 'main.beancount'])

    // 覆盖性校验：漏文件 / 越权路径 / 删除账本均被拒
    const ledgerMerged = readFileSync(ledgerPath, 'utf8') + '\n2026-08-09 * "解决" "冲突"\n  Expenses:Food  2.00 CNY\n  Assets:Bank:CNB  -2.00 CNY\n'
    const onlyLedger = (await handlers['sync:resolve-conflict']({}, {
      resolved: [{ path: 'main.beancount', content: ledgerMerged }]
    })) as { ok: boolean; message?: string }
    expect(onlyLedger.ok).toBe(false)
    expect(onlyLedger.message).toContain('未处理')

    const extraPath = (await handlers['sync:resolve-conflict']({}, {
      resolved: [
        { path: 'main.beancount', content: ledgerMerged },
        { path: SYNC_ACCOUNTS_FILE, content: accountsJson({ id: 1, name: 'x', value: 'Expenses:Food' }) },
        { path: SYNC_GITIGNORE_FILE, content: 'x\n' }
      ]
    })) as { ok: boolean; message?: string }
    expect(extraPath.ok).toBe(false)
    expect(extraPath.message).toContain('并非冲突文件')

    // 账本删除决议被拒（只允许对 JSON 文件采用「删除」）
    const deleteLedger = (await handlers['sync:resolve-conflict']({}, {
      resolved: [
        { path: 'main.beancount', content: null },
        { path: SYNC_ACCOUNTS_FILE, content: accountsJson({ id: 1, name: '餐费', value: 'Expenses:Food' }) }
      ]
    })) as { ok: boolean; message?: string }
    expect(deleteLedger.ok).toBe(false)
    expect(deleteLedger.message).toContain('账本文件不能被删除')

    // 非法 JSON（账户库）→ 校验失败，两侧文件均不动
    const ledgerBefore = readFileSync(ledgerPath, 'utf8')
    const accountsBefore = localText(SYNC_ACCOUNTS_FILE)
    const badAccounts = (await handlers['sync:resolve-conflict']({}, {
      resolved: [
        { path: 'main.beancount', content: ledgerMerged },
        { path: SYNC_ACCOUNTS_FILE, content: '{oops' }
      ]
    })) as { ok: boolean; message?: string }
    expect(badAccounts.ok).toBe(false)
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore) // 两阶段落盘：账本未被写入
    expect(localText(SYNC_ACCOUNTS_FILE)).toBe(accountsBefore)

    // 正常解决：账本用合并内容、账户库采用远端
    const resolved = (await handlers['sync:resolve-conflict']({}, {
      resolved: [
        { path: 'main.beancount', content: ledgerMerged },
        { path: SYNC_ACCOUNTS_FILE, content: accountsJson({ id: 1, name: '餐费', value: 'Expenses:Food' }) }
      ]
    })) as { ok: boolean }
    expect(resolved.ok).toBe(true)
    expect(await readRemoteFile(bareDir)).toBe(ledgerMerged)
    expect(await readRemoteFile(bareDir, SYNC_ACCOUNTS_FILE)).toContain('餐费')
    expect(localText(SYNC_ACCOUNTS_FILE)).toContain('餐费')
  }, 60_000)

  it('无改动重复 push → 远端提交数不变（不再产生空提交）', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    seedLocal('.beanwise/index.db', 'churn-1')
    await handlers['sync:push']()
    const before = await remoteCommitCount(bareDir)
    for (let i = 0; i < 3; i++) {
      seedLocal('.beanwise/index.db', `churn-${i + 2}`) // 索引缓存反复变动：旧实现会让工作区恒为「脏」
      const r = (await handlers['sync:push']()) as SyncResult
      expect(r.ok).toBe(true)
    }
    expect(await remoteCommitCount(bareDir)).toBe(before)
  }, 60_000)

  it('sync:clear → 配置与 PAT 清空', async () => {
    const url = await newRepo()
    const { tokens, config } = await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    expect(tokens.load()).toBeTruthy()
    expect(config.load()).not.toBeNull()
    await handlers['sync:clear']()
    expect(tokens.load()).toBeNull()
    expect(config.load()).toBeNull()
  }, 30_000)

  it('同步互斥：push 进行中再 push → 拒绝', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    appendFileSync(ledgerPath, '\n2026-08-09 * "互斥" "测试"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
    // 并发两个 push：withWriteLock 已串行化（第二个在第一个完成后执行），acquireSync 的 syncing
    // 标志是第二道闸；断言模板（brief）：被拒（{ok:false, message 含「同步进行中」}）或全部成功均接受
    const [a, b] = await Promise.allSettled([handlers['sync:push'](), handlers['sync:push']()])
    const settled = [a, b].map((r) => r.status)
    expect(settled).toContain('fulfilled')
    const results = [a, b].map((r) => (r.status === 'fulfilled' ? (r.value as SyncResult) : null))
    expect(results.some((r) => r?.ok === false && r?.message?.includes('同步进行中')) || results.every((r) => r?.ok)).toBe(true)
  }, 30_000)

  // ==================== M12：本机代理与超时（机器级） ====================

  it('M12 sync:get-network 默认 → 直连 + 30s', async () => {
    await setup()
    expect(handlers['sync:get-network']()).toEqual({ proxyUrl: null, timeoutSec: 30 })
  }, 30_000)

  it('M12 sync:save-network：合法保存按 origin 规范化，非法一律 ok:false 且不落盘', async () => {
    await setup()
    expect(await handlers['sync:save-network']({}, { proxyUrl: 'http://127.0.0.1:7890/', timeoutSec: 60 }))
      .toEqual({ ok: true, network: { proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 60 } })
    expect(handlers['sync:get-network']()).toEqual({ proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 60 })
    // 空串是合法值（= 直连），不是错误
    expect(await handlers['sync:save-network']({}, { proxyUrl: '   ', timeoutSec: 30 }))
      .toEqual({ ok: true, network: { proxyUrl: null, timeoutSec: 30 } })

    const bad: Array<[Record<string, unknown>, string]> = [
      [{ proxyUrl: 'socks5://127.0.0.1:1080', timeoutSec: 30 }, '仅支持 HTTP/HTTPS 代理地址'],
      [{ proxyUrl: 'http://127.0.0.1', timeoutSec: 30 }, '代理地址需带端口'],
      [{ proxyUrl: 'http://user:pw@127.0.0.1:7890', timeoutSec: 30 }, '代理地址不要携带用户名密码'],
      [{ proxyUrl: null, timeoutSec: 0 }, '超时必须是'],
      [{ proxyUrl: null, timeoutSec: 601 }, '超时必须是'],
      [{ proxyUrl: null, timeoutSec: 1.5 }, '超时必须是']
    ]
    for (const [params, hint] of bad) {
      const r = await handlers['sync:save-network']({}, params) as SaveNetworkResult
      expect(r.ok, JSON.stringify(params)).toBe(false)
      expect(r.error).toContain(hint)
    }
    // 非法保存不落盘：仍是上一次的合法值
    expect(handlers['sync:get-network']()).toEqual({ proxyUrl: null, timeoutSec: 30 })
  }, 30_000)

  it('M12 sync:test-connection：未配置仓库地址 → 提示先填', async () => {
    await setup()
    const r = await handlers['sync:test-connection']({}, {}) as TestConnectionResult
    expect(r.ok).toBe(false)
    expect(r.message).toContain('请先填写并保存仓库地址')
  }, 30_000)

  it('M12 回环绕过：配了代理，对回环仓库的握手仍直连成功', async () => {
    const url = await newRepo()
    const { network } = await setup()
    const direct = await handlers['sync:test-connection']({}, { repoUrl: url }) as TestConnectionResult
    expect(direct).toEqual({ ok: true, message: '连接成功（直连）' })
    // 代理指向死端口：目标是回环 → 必须绕过代理（否则单测/E2E 全灭）
    network.save({ proxyUrl: 'http://127.0.0.1:1', timeoutSec: 30 })
    expect(await handlers['sync:test-connection']({}, { repoUrl: url })).toMatchObject({ ok: true })
  }, 60_000)

  it('M12 sync:test-connection：代理不可达 → 诊断文案带出代理地址（零外网依赖）', async () => {
    const { network } = await setup()
    network.save({ proxyUrl: 'http://127.0.0.1:1', timeoutSec: 30 })
    // 目标非回环才会走代理；端口 1 必被拒 → 立即失败，不触外网
    const r = await handlers['sync:test-connection']({}, { repoUrl: 'https://github.com/beanwise/test' }) as TestConnectionResult
    expect(r.ok).toBe(false)
    expect(r.message).toContain('http://127.0.0.1:1')
  }, 30_000)

  // ==================== M13：提交人身份 ====================

  it('M13 sync:get-identity：默认 = 内置兜底（未手填、未识别）', async () => {
    await setup()
    expect(await handlers['sync:get-identity']()).toEqual({
      manual: null,
      detected: null,
      effective: { name: 'BeanWise', email: 'beanwise@local', source: 'default' }
    })
  })

  it('M13 sync:save-identity：合法 → 落库且生效值变手填；非法/半填 → ok:false 且不落库', async () => {
    const { identity } = await setup()
    const ok = await handlers['sync:save-identity']({}, { name: 'Zhang San', email: 'zhang@example.com' }) as SaveIdentityResult
    expect(ok.ok).toBe(true)
    expect(ok.state?.manual).toEqual({ name: 'Zhang San', email: 'zhang@example.com' })
    expect(ok.state?.effective).toEqual({ name: 'Zhang San', email: 'zhang@example.com', source: 'manual' })
    expect(identity.load(workDir).manual).toEqual({ name: 'Zhang San', email: 'zhang@example.com' })

    const half = await handlers['sync:save-identity']({}, { name: 'Li Si', email: '' }) as SaveIdentityResult
    expect(half.ok).toBe(false)
    expect(half.error).toContain('一起填')
    // 半填被拒后手填值不变（否则会静默清掉用户已保存的身份）
    expect(identity.load(workDir).manual).toEqual({ name: 'Zhang San', email: 'zhang@example.com' })

    const injected = await handlers['sync:save-identity']({}, { name: 'Li Si', email: 'a@b.c\ncommitter Evil <x> 1 +0000' }) as SaveIdentityResult
    expect(injected.ok).toBe(false)
    expect(injected.error).toContain('不能包含换行')
  }, 30_000)

  it('M13 sync:save-identity 两个都留空 → 清空手填值，回落自动识别/兜底', async () => {
    const { identity } = await setup()
    await handlers['sync:save-identity']({}, { name: 'Zhang San', email: 'zhang@example.com' })
    const cleared = await handlers['sync:save-identity']({}, { name: null, email: null }) as SaveIdentityResult
    expect(cleared.ok).toBe(true)
    expect(cleared.state?.manual).toBeNull()
    expect(cleared.state?.effective.source).toBe('default')
    expect(identity.load(workDir).manual).toBeNull()
  })

  it('M13 sync:detect-identity：未保存 PAT → ok:false（不触网）', async () => {
    await setup({ githubApiBaseUrl: 'http://127.0.0.1:1' })
    const r = await handlers['sync:detect-identity']() as { ok: boolean; message: string }
    expect(r.ok).toBe(false)
    expect(r.message).toContain('PAT')
  })

  it('M13 sync:detect-identity：识别成功 → 生效值变 GitHub 身份（noreply 邮箱），凭据与 UA 正确', async () => {
    const fakeApi: FakeGitHub = await startFakeGitHub()
    try {
      const { tokens, identity } = await setup({ githubApiBaseUrl: fakeApi.url })
      tokens.save('ghp_test')

      const r = await handlers['sync:detect-identity']() as { ok: boolean; message: string; state: GitIdentityState }
      expect(r.ok).toBe(true)
      expect(r.state.effective).toEqual({
        name: FAKE_GITHUB_USER.name,
        email: `42+koko@users.noreply.github.com`,
        source: 'pat'
      })
      expect(r.state.detected).toEqual({ login: 'koko', id: 42, name: 'Koko Zhang', at: new Date(FIXED_NOW).toISOString() })
      // 识别缓存落在**本工作目录**键下，且请求带着 PAT 与必需 UA
      expect(identity.load(workDir).detected?.login).toBe('koko')
      expect(identity.load(join(workDir, '..', 'some-other-ledger')).detected).toBeNull()
      expect(fakeApi.requests[0]?.authorization).toBe('Bearer ghp_test')
      expect(fakeApi.requests[0]?.userAgent).toBe('BeanWise')
    } finally {
      await fakeApi.close()
    }
  }, 30_000)

  it('M13 手填优先于识别结果；保存手填值不清掉识别缓存', async () => {
    const fakeApi = await startFakeGitHub()
    try {
      const { tokens, identity } = await setup({ githubApiBaseUrl: fakeApi.url })
      tokens.save('ghp_test')
      await handlers['sync:detect-identity']()

      const saved = await handlers['sync:save-identity']({}, { name: 'Zhang San', email: 'zhang@example.com' }) as SaveIdentityResult
      expect(saved.state?.effective.source).toBe('manual')
      // 保存手填值不得清掉识别缓存（两个半边各写各的）
      expect(identity.load(workDir).detected?.login).toBe('koko')

      const cleared = await handlers['sync:save-identity']({}, { name: null, email: null }) as SaveIdentityResult
      expect(cleared.state?.effective.source).toBe('pat')
    } finally {
      await fakeApi.close()
    }
  }, 30_000)

  it('M13 识别失败（GitHub 401）→ ok:false + 诊断文案，且不写入识别缓存', async () => {
    const fakeApi = await startFakeGitHub({ status: 401, body: '{"message":"Bad credentials"}' })
    try {
      const { tokens, identity } = await setup({ githubApiBaseUrl: fakeApi.url })
      tokens.save('ghp_bad')
      const r = await handlers['sync:detect-identity']() as { ok: boolean; message: string }
      expect(r.ok).toBe(false)
      expect(r.message).toContain('认证失败')
      expect(identity.load(workDir).detected).toBeNull()
    } finally {
      await fakeApi.close()
    }
  }, 30_000)

  it('M13 configure 尾随识别：回环仓库地址不触发（保证单测/E2E 零外连零拖慢）', async () => {
    const url = await newRepo()
    const { identity } = await setup({ githubApiBaseUrl: 'http://127.0.0.1:1' })
    expect(await handlers['sync:configure']({}, { repoUrl: url, pat: 'test-pat' })).toMatchObject({ ok: true })
    expect(identity.load(workDir).detected).toBeNull()
  }, 60_000)

  it('M13 sync:clear：清掉本工作目录的识别缓存，保留机器级手填值', async () => {
    const fakeApi = await startFakeGitHub()
    try {
      const { tokens, identity } = await setup({ githubApiBaseUrl: fakeApi.url })
      tokens.save('ghp_test')
      await handlers['sync:detect-identity']()
      await handlers['sync:save-identity']({}, { name: 'Zhang San', email: 'zhang@example.com' })

      expect(await handlers['sync:clear']()).toEqual({ ok: true })
      // 识别缓存是该目录 PAT 的派生物 → 一起清；手填值是机器级设置 → 保留
      expect(identity.load(workDir).detected).toBeNull()
      expect(identity.load(workDir).manual).toEqual({ name: 'Zhang San', email: 'zhang@example.com' })
    } finally {
      await fakeApi.close()
    }
  }, 30_000)
})
