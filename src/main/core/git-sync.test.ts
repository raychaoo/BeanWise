import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSync, GIT_AUTHOR, SYNC_BRANCH } from './git-sync'
import { mergeTrackedFiles } from './merge-engine'
import { createBareRepo, readRemoteFile, remoteCommitCount, seedRemote, startGitServer } from '../utils/test-servers/git-test-server'
import { startFakeProxy, type FakeProxy } from '../utils/test-servers/fake-proxy-server'
import { SYNC_ACCOUNTS_FILE, SYNC_GITIGNORE_BEGIN, SYNC_GITIGNORE_FILE } from '../../shared/sync-files'

const FIXTURE = resolve('python/tests/fixtures/main.beancount')
/** seedRemote 的远端追加内容（原 seedRemoteCommit 的固定载荷，参数化后由调用方传入） */
const REMOTE_SEED_PATCH = '\n2026-08-09 * "远端" "同步测试"\n  Expenses:Food  5.00 CNY\n  Assets:Bank:CNB  -5.00 CNY\n'

describe('GitSync（M6）', () => {
  let workDir: string
  let ledgerPath: string
  let bareDir: string
  let remoteUrl: string
  let server: { url: string; close: () => Promise<void> }
  let fakeProxy: FakeProxy | null = null

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'beanwise-gitsync-'))
    ledgerPath = join(workDir, 'main.beancount')
    copyFileSync(FIXTURE, ledgerPath)
    bareDir = await createBareRepo()
    server = await startGitServer(bareDir)
    remoteUrl = server.url
  })
  afterEach(async () => {
    if (fakeProxy) await fakeProxy.close()
    fakeProxy = null
    await server.close()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(bareDir, { recursive: true, force: true })
  })

  /** 写工作区内文件（自动建父目录——产品里 .beanwise 由 activateWorkspace 预建） */
  const seedFile = (relPath: string, content: string): void => {
    const full = join(workDir, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }

  it('isRepo：init 前 false，init 后 true', async () => {
    const sync = new GitSync({ ledgerPath })
    expect(await sync.isRepo()).toBe(false)
    await sync.initRepo()
    expect(await sync.isRepo()).toBe(true)
  })

  it('场景 A：init → add → commit → remote → push，裸仓可见内容', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo()
    await sync.addTrackedFiles()
    await sync.commit('init: 首次同步')
    await sync.addRemote(remoteUrl)
    await sync.push()
    expect(await readRemoteFile(bareDir)).toBe(readFileSync(ledgerPath, 'utf8'))
  }, 30_000)

  it('场景 B：clone 到账本目录（目录不存在自动创建）', async () => {
    const remoteWork = mkdtempSync(join(tmpdir(), 'beanwise-remote-'))
    try {
      // 远端已有内容：先在工作副本 init+push，再删掉本地账本目录模拟「本地无文件」
      copyFileSync(FIXTURE, join(remoteWork, 'main.beancount')) // brief 原测试漏了此步，git.add 会因文件不存在而失败
      await git.init({ fs, dir: remoteWork, defaultBranch: SYNC_BRANCH })
      await git.add({ fs, dir: remoteWork, filepath: 'main.beancount' })
      await git.commit({ fs, dir: remoteWork, message: 'init', author: GIT_AUTHOR })
      await git.addRemote({ fs, dir: remoteWork, remote: 'origin', url: remoteUrl })
      await git.push({ fs, http, dir: remoteWork, remote: 'origin', ref: SYNC_BRANCH })
      const fresh = join(mkdtempSync(join(tmpdir(), 'beanwise-clone-')), 'main.beancount')
      const sync = new GitSync({ ledgerPath: fresh })
      await sync.clone(remoteUrl)
      expect(readFileSync(fresh, 'utf8')).toBe(readFileSync(FIXTURE, 'utf8'))
      expect(await sync.isRepo()).toBe(true)
    } finally {
      rmSync(remoteWork, { recursive: true, force: true })
    }
  }, 30_000)

  it('analyzeMerge：本地领先（空仓）→ local-ahead', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    expect(await sync.analyzeMerge()).toEqual({ kind: 'local-ahead' })
  })

  it('analyzeMerge：unrelated 且账本内容一致 → merge（逐文件均无冲突，靠合并提交接上两端历史）', async () => {
    // 远端先有相同内容（通过第二个工作副本 push）
    const remoteWork = mkdtempSync(join(tmpdir(), 'beanwise-remote2-'))
    try {
      // 远端仓库复制同一份账本内容（brief 原测试漏了此步，git.add 会因文件不存在而失败）
      copyFileSync(FIXTURE, join(remoteWork, 'main.beancount'))
      await git.init({ fs, dir: remoteWork, defaultBranch: SYNC_BRANCH })
      await git.add({ fs, dir: remoteWork, filepath: 'main.beancount' })
      await git.commit({ fs, dir: remoteWork, message: 'init', author: GIT_AUTHOR })
      await git.addRemote({ fs, dir: remoteWork, remote: 'origin', url: remoteUrl })
      await git.push({ fs, http, dir: remoteWork, remote: 'origin', ref: SYNC_BRANCH })

      const sync = new GitSync({ ledgerPath })
      await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init: 本地')
      await sync.addRemote(remoteUrl)
      await sync.fetch()
      const status = await sync.analyzeMerge()
      // 本地多出的 .gitignore 远端没有 → 状态是 merge（M11 前会因「内容一致」短路成 local-ahead）；
      // 逐文件三路推导后无冲突、无落盘改动，合并提交把两端历史接上（比 force push 丢弃远端历史更好）
      expect(status.kind).toBe('merge')
      if (status.kind !== 'merge') return
      const plan = mergeTrackedFiles(status.files)
      expect(plan.hasConflict).toBe(false)
      expect(plan.files.every((f) => f.outcome.kind === 'unchanged')).toBe(true)
    } finally {
      rmSync(remoteWork, { recursive: true, force: true })
    }
  }, 30_000)

  it('analyzeMerge：unrelated 内容不一致 → merge（逐文件 base=null，账本必冲突）', async () => {
    const remoteWork = mkdtempSync(join(tmpdir(), 'beanwise-remote3-'))
    try {
      await git.init({ fs, dir: remoteWork, defaultBranch: SYNC_BRANCH })
      appendFileSync(join(remoteWork, 'main.beancount'), '2026-08-09 * "远端独有" "内容"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
      await git.add({ fs, dir: remoteWork, filepath: 'main.beancount' })
      await git.commit({ fs, dir: remoteWork, message: 'init', author: GIT_AUTHOR })
      await git.addRemote({ fs, dir: remoteWork, remote: 'origin', url: remoteUrl })
      await git.push({ fs, http, dir: remoteWork, remote: 'origin', ref: SYNC_BRANCH })

      const sync = new GitSync({ ledgerPath })
      await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init: 本地')
      await sync.addRemote(remoteUrl)
      await sync.fetch()
      const status = await sync.analyzeMerge()
      expect(status.kind).toBe('merge')
      if (status.kind === 'merge') {
        const ledger = status.files.find((f) => f.path === 'main.beancount')
        expect(ledger?.base).toBeNull() // unrelated：无共同祖先
        expect(ledger?.ours).toBe(readFileSync(ledgerPath, 'utf8'))
        expect(ledger?.theirs).toContain('远端独有')
        // 逐文件合并 → 账本两侧都新增且不同 → 冲突（M11 起冲突判定在 merge-engine）
        expect(mergeTrackedFiles(status.files).hasConflict).toBe(true)
      }
    } finally {
      rmSync(remoteWork, { recursive: true, force: true })
    }
  }, 30_000)

  it('analyzeMerge：远端领先（同祖先）→ merge + fastForward', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    await sync.addRemote(remoteUrl)
    await sync.push()
    await seedRemote(remoteUrl, REMOTE_SEED_PATCH) // 远端新增一笔
    await sync.fetch()
    const status = await sync.analyzeMerge()
    expect(status.kind).toBe('merge')
    if (status.kind === 'merge') {
      expect(status.fastForward).toBe(true)
      expect(status.files.find((f) => f.path === 'main.beancount')?.theirs).toContain('远端')
      // 仅远端改动 → 合并计划为「写远端内容」
      const plan = mergeTrackedFiles(status.files)
      expect(plan.hasConflict).toBe(false)
      expect(plan.files.find((f) => f.path === 'main.beancount')?.outcome.kind).toBe('write')
    }
  }, 30_000)

  it('analyzeMerge：两端改不同位置 → 逐文件自动合并（diff3）', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    await sync.addRemote(remoteUrl)
    await sync.push()
    await seedRemote(remoteUrl, REMOTE_SEED_PATCH) // 远端在 EOF 追加一笔
    await sync.fetch()
    // 本地在 Breakfast 交易前插入一笔（与远端 EOF 追加不重叠 → diff3 干净合并；
    // 注意：diff3 对「同一位置的两处追加」判冲突，故本地改位置插入）
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8')
      .replace('\n2026-01-02 * "Breakfast"',
        '\n2026-08-09 * "本地" "同步测试"\n  Expenses:Food  8.00 CNY\n  Assets:Bank:CNB  -8.00 CNY\n\n2026-01-02 * "Breakfast"'))
    await sync.addTrackedFiles(); await sync.commit('save: 本地提交')
    const status = await sync.analyzeMerge()
    expect(status.kind).toBe('merge')
    if (status.kind === 'merge') {
      expect(status.fastForward).toBe(false)
      const plan = mergeTrackedFiles(status.files)
      expect(plan.hasConflict).toBe(false)
      const ledgerOutcome = plan.files.find((f) => f.path === 'main.beancount')?.outcome
      expect(ledgerOutcome?.kind).toBe('write')
      const content = ledgerOutcome?.kind === 'write' ? ledgerOutcome.content : ''
      expect(content).toContain('远端')
      expect(content).toContain('本地')
    }
  }, 30_000)

  it('analyzeMerge：同一行修改 → 冲突快照完整（三态交给 merge-engine）', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    await sync.addRemote(remoteUrl)
    await sync.push()
    // 远端把 Breakfast 行改掉
    const remoteWork = mkdtempSync(join(tmpdir(), 'beanwise-remote4-'))
    try {
      await git.clone({ fs, http, dir: remoteWork, url: remoteUrl, singleBranch: true })
      const p = join(remoteWork, 'main.beancount')
      writeFileSync(p, readFileSync(p, 'utf8').replace('* "Breakfast"', '* "Breakfast-Remote"'))
      await git.add({ fs, dir: remoteWork, filepath: 'main.beancount' })
      await git.commit({ fs, dir: remoteWork, message: 'seed: 改行', author: GIT_AUTHOR })
      await git.push({ fs, http, dir: remoteWork, remote: 'origin', ref: SYNC_BRANCH })
    } finally {
      rmSync(remoteWork, { recursive: true, force: true })
    }
    // 本地也改同一行
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('* "Breakfast"', '* "Breakfast-Local"'))
    await sync.addTrackedFiles(); await sync.commit('save: 本地改行')
    await sync.fetch()
    const status = await sync.analyzeMerge()
    expect(status.kind).toBe('merge')
    if (status.kind === 'merge') {
      const ledger = status.files.find((f) => f.path === 'main.beancount')
      expect(ledger?.ours).toContain('Breakfast-Local')
      expect(ledger?.theirs).toContain('Breakfast-Remote')
      expect(ledger?.base).toContain('Breakfast')
      const plan = mergeTrackedFiles(status.files)
      expect(plan.conflicts.map((c) => c.path)).toEqual(['main.beancount'])
    }
  }, 30_000)

  it('hasUncommitted：提交后 false，修改后 true', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    expect(await sync.hasUncommitted()).toBe(false)
    appendFileSync(ledgerPath, '\n2026-08-09 * "x" "y"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
    expect(await sync.hasUncommitted()).toBe(true)
  })

  // ---- M11：追踪文件集 ----

  it('追踪文件集：账户库 / Excel 模板 / .gitignore 一起提交，index.db 与 sync-config.json 被忽略', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo()
    seedFile(SYNC_ACCOUNTS_FILE, JSON.stringify({ accounts: [{ id: 1, name: '餐饮', value: 'Expenses:Food', description: '' }] }, null, 2))
    seedFile('.beanwise/index.db', 'binary-ish')
    seedFile('.beanwise/sync-config.json', '{"repoUrl":"x"}')
    await sync.addTrackedFiles()
    await sync.commit('init: 首次同步')
    await sync.addRemote(remoteUrl)
    await sync.push()

    expect(await readRemoteFile(bareDir)).toBe(readFileSync(ledgerPath, 'utf8'))
    expect(await readRemoteFile(bareDir, SYNC_ACCOUNTS_FILE)).toContain('Expenses:Food')
    expect(await readRemoteFile(bareDir, SYNC_GITIGNORE_FILE)).toContain('.beanwise/index.db')
    // 主机密/缓存文件绝不进仓库
    expect(await readRemoteFile(bareDir, '.beanwise/index.db')).toBeNull()
    expect(await readRemoteFile(bareDir, '.beanwise/sync-config.json')).toBeNull()
  }, 30_000)

  it('hasUncommitted 回归：未跟踪的 index.db / sync-config.json 不再让工作区恒为「脏」', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    expect(await sync.hasUncommitted()).toBe(false)
    // 旧实现（statusMatrix 全工作区扫描）在这两个文件存在时恒返回 true → 每次 push 都产生空提交
    seedFile('.beanwise/index.db', 'binary-ish')
    seedFile('.beanwise/sync-config.json', '{"repoUrl":"x"}')
    expect(await sync.hasUncommitted()).toBe(false)
    // 追踪文件改动仍然认得出
    seedFile(SYNC_ACCOUNTS_FILE, '{"accounts":[]}')
    expect(await sync.hasUncommitted()).toBe(true)
  })

  it('ensureGitignore：无文件时创建；已有用户规则时只追加不覆写；二次调用幂等', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo()
    await sync.ensureGitignore()
    const created = readFileSync(join(workDir, SYNC_GITIGNORE_FILE), 'utf8')
    expect(created).toContain(SYNC_GITIGNORE_BEGIN)
    await sync.ensureGitignore()
    expect(readFileSync(join(workDir, SYNC_GITIGNORE_FILE), 'utf8')).toBe(created) // 幂等

    // 用户自己已有一份 .gitignore → 追加托管块，原规则保留
    const user = 'node_modules/\n*.log\n'
    seedFile(SYNC_GITIGNORE_FILE, user)
    await sync.ensureGitignore()
    const merged = readFileSync(join(workDir, SYNC_GITIGNORE_FILE), 'utf8')
    expect(merged.startsWith(user)).toBe(true)
    expect(merged).toContain(SYNC_GITIGNORE_BEGIN)
    await sync.ensureGitignore()
    expect(readFileSync(join(workDir, SYNC_GITIGNORE_FILE), 'utf8')).toBe(merged)
  })

  it('用户 .gitignore 写了 .beanwise/ 时账户库仍会被提交（force + ignored）', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo()
    seedFile(SYNC_GITIGNORE_FILE, '.beanwise/\n')
    seedFile(SYNC_ACCOUNTS_FILE, JSON.stringify({ accounts: [] }, null, 2))
    await sync.addTrackedFiles()
    await sync.commit('init')
    await sync.addRemote(remoteUrl)
    await sync.push()
    // 若 add 未加 force，git.add 会静默跳过被忽略的未跟踪文件 → 账户库永远同步不出去
    expect(await readRemoteFile(bareDir, SYNC_ACCOUNTS_FILE)).toBe('{\n  "accounts": []\n}')
  }, 30_000)

  it('同步范围内删除文件 → addTrackedFiles 把删除写进索引并提交', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo()
    seedFile(SYNC_ACCOUNTS_FILE, JSON.stringify({ accounts: [{ id: 1, name: 'x', value: 'Expenses:X', description: '' }] }, null, 2))
    await sync.addTrackedFiles(); await sync.commit('init')
    await sync.addRemote(remoteUrl); await sync.push()
    expect(await readRemoteFile(bareDir, SYNC_ACCOUNTS_FILE)).toContain('Expenses:X')

    rmSync(join(workDir, SYNC_ACCOUNTS_FILE))
    await sync.addTrackedFiles()
    expect(await sync.hasUncommitted()).toBe(true)
    await sync.commit('save: 删除账户库')
    await sync.push()
    expect(await readRemoteFile(bareDir, SYNC_ACCOUNTS_FILE)).toBeNull()
  }, 30_000)

  it('analyzeMerge：只改远端账户库 → 逐文件三态独立（账本 unchanged）', async () => {
    const emptyAccounts = JSON.stringify({ accounts: [] }, null, 2)
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo()
    seedFile(SYNC_ACCOUNTS_FILE, emptyAccounts)
    await sync.addTrackedFiles(); await sync.commit('init')
    await sync.addRemote(remoteUrl); await sync.push()

    await seedRemote(remoteUrl, {
      [SYNC_ACCOUNTS_FILE]: JSON.stringify({ accounts: [{ id: 1, name: '房租', value: 'Expenses:Rent', description: '' }] }, null, 2)
    })
    await sync.fetch()
    const status = await sync.analyzeMerge()
    expect(status.kind).toBe('merge')
    if (status.kind !== 'merge') return
    const ledger = status.files.find((f) => f.path === 'main.beancount')
    const accounts = status.files.find((f) => f.path === SYNC_ACCOUNTS_FILE)
    expect(ledger?.base).toBe(ledger?.ours) // 账本本地未动
    expect(accounts?.ours).toBe(emptyAccounts)
    expect(accounts?.theirs).toContain('Expenses:Rent')
    const plan = mergeTrackedFiles(status.files)
    expect(plan.hasConflict).toBe(false)
    expect(plan.files.find((f) => f.path === 'main.beancount')?.outcome.kind).toBe('unchanged')
    expect(plan.files.find((f) => f.path === SYNC_ACCOUNTS_FILE)?.outcome.kind).toBe('write')
  }, 30_000)

  it('追踪文件集：无改动时不再产生空提交（远程提交数不变）', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    await sync.addRemote(remoteUrl); await sync.push()
    const before = await remoteCommitCount(bareDir)

    seedFile('.beanwise/index.db', 'churn') // 索引缓存反复变动
    for (let i = 0; i < 3; i++) {
      await sync.addTrackedFiles()
      if (await sync.hasUncommitted()) await sync.commit(`save: ${i}`)
      await sync.push()
    }
    expect(await remoteCommitCount(bareDir)).toBe(before)
  }, 60_000)

  it('listServerRefs：空仓 → []；非空 → 有 ref', async () => {
    const sync = new GitSync({ ledgerPath })
    expect(await sync.listServerRefs(remoteUrl)).toEqual([])
    await seedRemote(remoteUrl, REMOTE_SEED_PATCH)
    const refs = await sync.listServerRefs(remoteUrl)
    expect(refs.some((r) => r.ref === `refs/heads/${SYNC_BRANCH}`)).toBe(true)
  }, 30_000)

  // ==================== M12：本机代理与超时 ====================

  it('M12 回环绕过：配了代理，对回环仓库的 fetch/push 仍直连可用', async () => {
    // 代理指向死端口：目标回环必须绕过它，否则整个同步链路（含全部 E2E）当场断掉
    const sync = new GitSync({
      ledgerPath,
      network: () => ({ proxyUrl: 'http://127.0.0.1:1', timeoutSec: 30 })
    })
    await sync.initRepo(); await sync.addTrackedFiles(); await sync.commit('init')
    await sync.addRemote(remoteUrl)
    await sync.push()
    expect(await readRemoteFile(bareDir)).toBe(readFileSync(ledgerPath, 'utf8'))
    await sync.fetch()
  }, 60_000)

  it('M12 代理生效：非回环目标走代理（假代理收到 CONNECT），不再直连', async () => {
    fakeProxy = await startFakeProxy()
    const sync = new GitSync({
      ledgerPath,
      network: () => ({ proxyUrl: fakeProxy!.url, timeoutSec: 30 })
    })
    // 不存在的域名 + 假代理：确定性证明请求被送进了代理（零外网）
    await expect(sync.listServerRefs('https://example.invalid/beanwise.git')).rejects.toThrow()
    expect(fakeProxy.connects).toEqual(['example.invalid:443'])
  }, 30_000)

  it('M12 超时可配置：超时毫秒数取自 network（覆盖构造参数）', async () => {
    fakeProxy = await startFakeProxy({ hang: true })
    const sync = new GitSync({
      ledgerPath,
      timeoutMs: 30_000,
      network: () => ({ proxyUrl: fakeProxy!.url, timeoutSec: 1 })
    })
    // 假代理只收 CONNECT、不回包 → 必然超时；文案里的数值必须是 network 的 1s，而不是构造参数的 30s
    await expect(sync.listServerRefs('https://example.invalid/beanwise.git'))
      .rejects.toThrow('git 操作超时（1000ms）')
  }, 30_000)

  // ==================== M13：提交人身份 ====================

  it('M13 身份注入：author 与 committer 都是注入值（不传 committer → 回落到 author）', async () => {
    const sync = new GitSync({
      ledgerPath,
      identity: () => ({ name: 'Zhang San', email: '42+zhangsan@users.noreply.github.com' })
    })
    await sync.initRepo()
    await sync.addTrackedFiles()
    await sync.commit('save: 带身份')

    // 读回**真实 commit 对象**（不只看返回值）——只断言 name/email：
    // 两处 timestamp 各取一次 Date.now()，跨秒边界时 author/committer 的秒数可能不同（会 flake）
    const oid = await sync.headOid()
    const { commit } = await git.readCommit({ fs, dir: workDir, oid })
    const expected = { name: 'Zhang San', email: '42+zhangsan@users.noreply.github.com' }
    expect(commit.author).toMatchObject(expected)
    expect(commit.committer).toMatchObject(expected)
  })

  it('M13 未注入身份 → 仍是内置兜底（与 M12 之前行为一致）；注入函数抛错也回落到兜底', async () => {
    const plain = new GitSync({ ledgerPath })
    await plain.initRepo()
    await plain.addTrackedFiles()
    await plain.commit('save: 兜底')
    const { commit } = await git.readCommit({ fs, dir: workDir, oid: await plain.headOid() })
    expect(commit.author).toMatchObject(GIT_AUTHOR)
    expect(commit.committer).toMatchObject(GIT_AUTHOR)

    // 配置读坏绝不能断掉同步（同 GitNetworkStore.load / createGitHttp 的兜底原则）
    const broken = new GitSync({
      ledgerPath,
      identity: () => { throw new Error('store 读坏了') }
    })
    await broken.addTrackedFiles()
    await broken.commit('save: 兜底（配置损坏）')
    const { commit: commit2 } = await git.readCommit({ fs, dir: workDir, oid: await broken.headOid() })
    expect(commit2.author).toMatchObject(GIT_AUTHOR)
  })
})
