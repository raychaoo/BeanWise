import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzle, openDatabase } from '../../db/index'
import { GitSync, GIT_AUTHOR, SYNC_BRANCH } from '../../core/git-sync'
import { createBareRepo, readRemoteFile, seedRemote, seedRemoteInit, startGitServer } from '../../utils/test-servers/git-test-server'
import { getLedgerStatus } from '../../core/index-builder'
import { registerSyncHandlers } from './ipc-handlers-sync'
import type { IpcRegistrar } from '../ledger/ipc-handlers'
import type { ConfigureSyncResult, SyncConfig, SyncResult } from '../../../shared/ipc'
import { PythonSvc } from '../../core/python-svc'
import type { SyncConfigStore, TokenStore } from '../../stores/token-store'
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

  async function setup(opts: { seed?: string; withLocal?: boolean } = {}): Promise<{ tokens: TokenStore; config: SyncConfigStore }> {
    workDir = mkdtempSync(join(tmpdir(), 'beanwise-synch-'))
    ledgerPath = join(workDir, 'main.beancount')
    if (opts.withLocal !== false) copyFileSync(FIXTURE, ledgerPath)
    const tokens: TokenStore = new InMemoryTokenStore()
    const config: SyncConfigStore = new InMemoryConfigStore()
    const gitSync = new GitSync({
      ledgerPath,
      auth: () => ({ username: 'x-access-token', password: tokens.load() ?? '' })
    })
    const ipc: IpcRegistrar = { handle: (c, l) => { handlers[c] = l as (...args: unknown[]) => unknown } }
    handlers = {}
    registerSyncHandlers(ipc, { db, engine, ledgerPath, tokens, config, git: gitSync, now: () => FIXED_NOW })
    if (opts.seed) await seedRemote(server!.url, opts.seed)
    return { tokens, config }
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

  it('sync:configure 场景 C 不一致：conflict 三路快照（base 空串）', async () => {
    const url = await newRepo()
    // 远端初始 = 本地 fixture 内容（一致），再追加一笔（→ 与本地不一致）
    await seedRemoteInit(url, readFileSync(FIXTURE, 'utf8'))
    await seedRemote(url, '\n2026-08-09 * "远端独有" "接管"\n  Expenses:Food  2.00 CNY\n  Assets:Bank:CNB  -2.00 CNY\n')
    await setup()
    const r = (await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })) as ConfigureSyncResult
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    expect(r.base).toBe('')
    expect(r.ours).toContain('Breakfast')
    expect(r.theirs).toContain('远端独有')
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
    expect(r.ours).toContain('Breakfast-Local')
    expect(r.theirs).toContain('Breakfast-Remote')
    expect(r.base).toContain('Breakfast')
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
    const r = (await handlers['sync:resolve-conflict']({}, { content: merged })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(await readRemoteFile(bareDir)).toBe(merged)
  }, 30_000)

  it('sync:resolve-conflict 校验失败：借贷不平 → ok:false + 文件不变', async () => {
    const url = await newRepo()
    await setup()
    await handlers['sync:configure']({}, { repoUrl: url, pat: 'p' })
    const before = readFileSync(ledgerPath, 'utf8')
    const bad = '2026-08-09 * "坏" "内容"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -9.00 CNY\n'
    const r = (await handlers['sync:resolve-conflict']({}, { content: bad })) as { ok: boolean; message?: string }
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
    const r = (await handlers['sync:resolve-conflict']({}, { content: merged })) as SyncResult
    expect(r.ok).toBe(false)
    expect(r.message).toContain('远端已有新变更')
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)
    expect(await readRemoteFile(bareDir)).not.toContain('解决')
  }, 30_000)

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
})
