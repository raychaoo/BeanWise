import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSync, GIT_AUTHOR, SYNC_BRANCH } from './git-sync'
import { createBareRepo, readRemoteFile, seedRemote, startGitServer } from '../utils/test-servers/git-test-server'

const FIXTURE = resolve('python/tests/fixtures/main.beancount')
/** seedRemote 的远端追加内容（原 seedRemoteCommit 的固定载荷，参数化后由调用方传入） */
const REMOTE_SEED_PATCH = '\n2026-08-09 * "远端" "同步测试"\n  Expenses:Food  5.00 CNY\n  Assets:Bank:CNB  -5.00 CNY\n'

describe('GitSync（M6）', () => {
  let workDir: string
  let ledgerPath: string
  let bareDir: string
  let remoteUrl: string
  let server: { url: string; close: () => Promise<void> }

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'beanwise-gitsync-'))
    ledgerPath = join(workDir, 'main.beancount')
    copyFileSync(FIXTURE, ledgerPath)
    bareDir = await createBareRepo()
    server = await startGitServer(bareDir)
    remoteUrl = server.url
  })
  afterEach(async () => {
    await server.close()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(bareDir, { recursive: true, force: true })
  })

  it('isRepo：init 前 false，init 后 true', async () => {
    const sync = new GitSync({ ledgerPath })
    expect(await sync.isRepo()).toBe(false)
    await sync.initRepo()
    expect(await sync.isRepo()).toBe(true)
  })

  it('场景 A：init → add → commit → remote → push，裸仓可见内容', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo()
    await sync.addLedgerFile()
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
    await sync.initRepo(); await sync.addLedgerFile(); await sync.commit('init')
    expect(await sync.analyzeMerge()).toEqual({ kind: 'local-ahead' })
  })

  it('analyzeMerge：unrelated 内容一致 → local-ahead（场景 C 接管）', async () => {
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
      await sync.initRepo(); await sync.addLedgerFile(); await sync.commit('init: 本地')
      await sync.addRemote(remoteUrl)
      await sync.fetch()
      const status = await sync.analyzeMerge()
      expect(status.kind).toBe('local-ahead')
    } finally {
      rmSync(remoteWork, { recursive: true, force: true })
    }
  }, 30_000)

  it('analyzeMerge：unrelated 内容不一致 → conflict(base 空串)（场景 C 接管冲突）', async () => {
    const remoteWork = mkdtempSync(join(tmpdir(), 'beanwise-remote3-'))
    try {
      await git.init({ fs, dir: remoteWork, defaultBranch: SYNC_BRANCH })
      appendFileSync(join(remoteWork, 'main.beancount'), '2026-08-09 * "远端独有" "内容"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
      await git.add({ fs, dir: remoteWork, filepath: 'main.beancount' })
      await git.commit({ fs, dir: remoteWork, message: 'init', author: GIT_AUTHOR })
      await git.addRemote({ fs, dir: remoteWork, remote: 'origin', url: remoteUrl })
      await git.push({ fs, http, dir: remoteWork, remote: 'origin', ref: SYNC_BRANCH })

      const sync = new GitSync({ ledgerPath })
      await sync.initRepo(); await sync.addLedgerFile(); await sync.commit('init: 本地')
      await sync.addRemote(remoteUrl)
      await sync.fetch()
      const status = await sync.analyzeMerge()
      expect(status.kind).toBe('conflict')
      if (status.kind === 'conflict') {
        expect(status.base).toBe('')
        expect(status.ours).toBe(readFileSync(ledgerPath, 'utf8'))
        expect(status.theirs).toContain('远端独有')
      }
    } finally {
      rmSync(remoteWork, { recursive: true, force: true })
    }
  }, 30_000)

  it('analyzeMerge：远端领先（同祖先）→ fast-forward + theirsContent', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addLedgerFile(); await sync.commit('init')
    await sync.addRemote(remoteUrl)
    await sync.push()
    await seedRemote(remoteUrl, REMOTE_SEED_PATCH) // 远端新增一笔
    await sync.fetch()
    const status = await sync.analyzeMerge()
    expect(status.kind).toBe('fast-forward')
    if (status.kind === 'fast-forward') expect(status.theirsContent).toContain('远端')
  }, 30_000)

  it('analyzeMerge：两端改不同位置 → clean-merge（diff3 自动合并）', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addLedgerFile(); await sync.commit('init')
    await sync.addRemote(remoteUrl)
    await sync.push()
    await seedRemote(remoteUrl, REMOTE_SEED_PATCH) // 远端在 EOF 追加一笔
    await sync.fetch()
    // 本地在 Breakfast 交易前插入一笔（与远端 EOF 追加不重叠 → diff3 干净合并；
    // 注意：diff3 对「同一位置的两处追加」判冲突，故本地改位置插入）
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8')
      .replace('\n2026-01-02 * "Breakfast"',
        '\n2026-08-09 * "本地" "同步测试"\n  Expenses:Food  8.00 CNY\n  Assets:Bank:CNB  -8.00 CNY\n\n2026-01-02 * "Breakfast"'))
    await sync.addLedgerFile(); await sync.commit('save: 本地提交')
    const status = await sync.analyzeMerge()
    expect(status.kind).toBe('clean-merge')
    if (status.kind === 'clean-merge') {
      expect(status.content).toContain('远端')
      expect(status.content).toContain('本地')
    }
  }, 30_000)

  it('analyzeMerge：同一行修改 → conflict（三路快照完整）', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addLedgerFile(); await sync.commit('init')
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
    await sync.addLedgerFile(); await sync.commit('save: 本地改行')
    await sync.fetch()
    const status = await sync.analyzeMerge()
    expect(status.kind).toBe('conflict')
    if (status.kind === 'conflict') {
      expect(status.ours).toContain('Breakfast-Local')
      expect(status.theirs).toContain('Breakfast-Remote')
      expect(status.base).toContain('Breakfast')
    }
  }, 30_000)

  it('hasUncommitted：提交后 false，修改后 true', async () => {
    const sync = new GitSync({ ledgerPath })
    await sync.initRepo(); await sync.addLedgerFile(); await sync.commit('init')
    expect(await sync.hasUncommitted()).toBe(false)
    appendFileSync(ledgerPath, '\n2026-08-09 * "x" "y"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
    expect(await sync.hasUncommitted()).toBe(true)
  })

  it('listServerRefs：空仓 → []；非空 → 有 ref', async () => {
    const sync = new GitSync({ ledgerPath })
    expect(await sync.listServerRefs(remoteUrl)).toEqual([])
    await seedRemote(remoteUrl, REMOTE_SEED_PATCH)
    const refs = await sync.listServerRefs(remoteUrl)
    expect(refs.some((r) => r.ref === `refs/heads/${SYNC_BRANCH}`)).toBe(true)
  }, 30_000)
})
