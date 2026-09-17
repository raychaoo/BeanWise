import { beforeEach, expect, it, vi } from 'vitest'

// vi.mock 工厂在 import 求值期（本文件模块体执行前）解析，直接引用顶层 const 会 TDZ
// ReferenceError（vitest 4.1.10 实测，同 ledger-editor.test.ts）；vi.hoisted 提前初始化。
const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useSyncStore } from './sync'
import { useLedgerStore } from './ledger'

type StubApi = {
  getSyncStatus: ReturnType<typeof vi.fn>
  configureSync: ReturnType<typeof vi.fn>
  pushLedger: ReturnType<typeof vi.fn>
  pullLedger: ReturnType<typeof vi.fn>
  resolveSyncConflict: ReturnType<typeof vi.fn>
  clearSync: ReturnType<typeof vi.fn>
  getGitNetwork: ReturnType<typeof vi.fn>
  saveGitNetwork: ReturnType<typeof vi.fn>
  testSyncConnection: ReturnType<typeof vi.fn>
  getLedgerStatus: ReturnType<typeof vi.fn>
  listLedgerEntries: ReturnType<typeof vi.fn>
  listLedgerAccounts: ReturnType<typeof vi.fn>
  getAccountConfig: ReturnType<typeof vi.fn>
  listLedgerCounterparties: ReturnType<typeof vi.fn>
  saveAccountConfig: ReturnType<typeof vi.fn>
  refreshLedgerIndex: ReturnType<typeof vi.fn>
}

function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
  const api: StubApi = {
    getSyncStatus: vi.fn().mockResolvedValue({ configured: false, lastSyncAt: null, lastError: null, syncing: false }),
    configureSync: vi.fn(),
    pushLedger: vi.fn().mockResolvedValue({ ok: true }),
    pullLedger: vi.fn().mockResolvedValue({ ok: true }),
    resolveSyncConflict: vi.fn().mockResolvedValue({ ok: true, status: 'ok', entryCount: 0, errorCount: 0 }),
    clearSync: vi.fn().mockResolvedValue({ ok: true }),
    getGitNetwork: vi.fn().mockResolvedValue({ proxyUrl: null, timeoutSec: 30 }),
    saveGitNetwork: vi.fn().mockResolvedValue({ ok: true, network: { proxyUrl: null, timeoutSec: 30 } }),
    testSyncConnection: vi.fn().mockResolvedValue({ ok: true, message: '连接成功（直连）' }),
    getLedgerStatus: vi.fn().mockResolvedValue(null),
    listLedgerEntries: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    listLedgerAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
    getAccountConfig: vi.fn().mockResolvedValue({ ok: true, accounts: [] }),
    listLedgerCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
    saveAccountConfig: vi.fn().mockResolvedValue({ ok: true, accounts: [] }),
    refreshLedgerIndex: vi.fn().mockResolvedValue({ changed: false, status: 'ok', entryCount: 0, errorCount: 0 }),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useSyncStore.setState({ status: null, conflict: null, syncing: false, generation: 0, network: null })
  useLedgerStore.setState({
    status: null, entries: [], total: 0, accountOptions: [], accountValues: [], loading: false, error: null,
    editorContent: null, editorOriginal: null, editorFingerprint: null,
    editorLoaded: false, editorMissing: false, editorSaving: false, editorConflict: null
  })
  Object.values(message).forEach((m) => m.mockClear())
})

it('loadStatus：已配置 → status 落 store', async () => {
  const api = stubBeanwise({ getSyncStatus: vi.fn().mockResolvedValue({ configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false }) })
  await useSyncStore.getState().loadStatus()
  expect(useSyncStore.getState().status?.configured).toBe(true)
  expect(api.getSyncStatus).toHaveBeenCalled()
})

it('configure 成功 → status 更新 + 成功提示', async () => {
  stubBeanwise({ configureSync: vi.fn().mockResolvedValue({ ok: true, status: { configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false } }) })
  const ok = await useSyncStore.getState().configure('https://github.com/a/b', 'pat')
  expect(ok).toBe(true)
  expect(useSyncStore.getState().status?.configured).toBe(true)
  expect(message.success).toHaveBeenCalledWith('同步配置成功')
})

it('configure 场景 C 冲突 → conflict 落 store + 不报成功', async () => {
  stubBeanwise({ configureSync: vi.fn().mockResolvedValue({ ok: false, conflict: true, conflicts: [{ path: 'main.beancount', base: null, ours: 'local', theirs: 'remote' }] }) })
  const ok = await useSyncStore.getState().configure('https://github.com/a/b', 'pat')
  expect(ok).toBe(false)
  expect(useSyncStore.getState().conflict).toEqual({ files: [{ path: 'main.beancount', base: null, ours: 'local', theirs: 'remote' }] })
  expect(message.success).not.toHaveBeenCalled()
  expect(message.warning).toHaveBeenCalled()
})

it('configure 失败（连接错误）→ 错误提示 + 无冲突状态', async () => {
  stubBeanwise({ configureSync: vi.fn().mockResolvedValue({ ok: false, error: '认证失败' }) })
  const ok = await useSyncStore.getState().configure('https://github.com/a/b', 'pat')
  expect(ok).toBe(false)
  expect(useSyncStore.getState().conflict).toBeNull()
  expect(message.error).toHaveBeenCalled()
})

it('push 成功 → 成功提示 + ledgerStore.refresh 联动', async () => {
  const api = stubBeanwise()
  useSyncStore.setState({ status: { configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false } })
  await useSyncStore.getState().push()
  expect(api.pushLedger).toHaveBeenCalled()
  expect(message.success).toHaveBeenCalledWith('已同步到远端')
  expect(api.getLedgerStatus).toHaveBeenCalled() // refresh 联动
})

it('push 冲突 → conflict 落 store + 警告提示', async () => {
  stubBeanwise({ pushLedger: vi.fn().mockResolvedValue({ ok: false, conflict: true, conflicts: [{ path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' }] }) })
  useSyncStore.setState({ status: { configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false } })
  await useSyncStore.getState().push()
  expect(useSyncStore.getState().conflict).toEqual({ files: [{ path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' }] })
  expect(message.warning).toHaveBeenCalled()
  expect(message.success).not.toHaveBeenCalled()
})

it('push：未配置（status.configured=false）→ 静默跳过，不发 IPC 不弹提示', async () => {
  const api = stubBeanwise({ pushLedger: vi.fn().mockResolvedValue({ ok: true }) })
  useSyncStore.setState({ status: { configured: false, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: null, lastError: null, syncing: false } })
  await useSyncStore.getState().push()
  expect(api.pushLedger).not.toHaveBeenCalled()
  expect(message.warning).not.toHaveBeenCalled()
  expect(message.success).not.toHaveBeenCalled()
})

it('push：status null（clear 后 / loadStatus 前）→ 静默跳过，不发 IPC 不弹提示', async () => {
  // M6 终审修复 I-3：旧守卫 `status && !status.configured` 对 null 穿透 → 每次保存弹「同步失败」
  const api = stubBeanwise({ pushLedger: vi.fn().mockResolvedValue({ ok: true }) })
  useSyncStore.setState({ status: null })
  await useSyncStore.getState().push()
  expect(api.pushLedger).not.toHaveBeenCalled()
  expect(message.warning).not.toHaveBeenCalled()
  expect(message.success).not.toHaveBeenCalled()
})

it('push 成功（先置冲突）→ conflict 清空', async () => {
  // M6 终审修复 I-2b：自动合并落盘后清陈旧快照，防其再覆写刚合并内容
  stubBeanwise()
  useSyncStore.setState({ status: { configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false }, conflict: { files: [{ path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' }] } })
  await useSyncStore.getState().push()
  expect(useSyncStore.getState().conflict).toBeNull()
  expect(message.success).toHaveBeenCalledWith('已同步到远端')
})

it('pull 成功（先置冲突）→ conflict 清空', async () => {
  stubBeanwise()
  useSyncStore.setState({ conflict: { files: [{ path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' }] } })
  await useSyncStore.getState().pull()
  expect(useSyncStore.getState().conflict).toBeNull()
  expect(message.success).toHaveBeenCalledWith('已拉取远端更新')
})

it('push：已配置（status.configured=true）→ 行为不变', async () => {
  const api = stubBeanwise()
  useSyncStore.setState({ status: { configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false } })
  await useSyncStore.getState().push()
  expect(api.pushLedger).toHaveBeenCalled()
  expect(message.success).toHaveBeenCalledWith('已同步到远端')
})

it('push 失败（网络）→ 警告提示 + lastError 状态刷新', async () => {
  stubBeanwise({ pushLedger: vi.fn().mockResolvedValue({ ok: false, message: '连接超时' }) })
  useSyncStore.setState({ status: { configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false } })
  await useSyncStore.getState().push()
  expect(message.warning).toHaveBeenCalledWith('同步失败：连接超时')
  expect(useSyncStore.getState().conflict).toBeNull()
})

it('pull 成功 → 成功提示 + refresh 联动', async () => {
  const api = stubBeanwise()
  await useSyncStore.getState().pull()
  expect(api.pullLedger).toHaveBeenCalled()
  expect(message.success).toHaveBeenCalledWith('已拉取远端更新')
})

it('resolveConflict 成功 → 冲突清空 + 成功提示 + refresh', async () => {
  const api = stubBeanwise()
  useSyncStore.setState({ conflict: { files: [{ path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' }] } })
  const ok = await useSyncStore.getState().resolveConflict([{ path: 'main.beancount', content: 'merged' }])
  expect(ok).toBe(true)
  expect(api.resolveSyncConflict).toHaveBeenCalledWith({ resolved: [{ path: 'main.beancount', content: 'merged' }] })
  expect(useSyncStore.getState().conflict).toBeNull()
  expect(message.success).toHaveBeenCalled()
})

it('resolveConflict 校验失败 → 错误提示 + 冲突保留', async () => {
  stubBeanwise({ resolveSyncConflict: vi.fn().mockResolvedValue({ ok: false, message: 'Transaction does not balance' }) })
  useSyncStore.setState({ conflict: { files: [{ path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' }] } })
  const ok = await useSyncStore.getState().resolveConflict([{ path: 'main.beancount', content: 'bad' }])
  expect(ok).toBe(false)
  expect(useSyncStore.getState().conflict).not.toBeNull()
  expect(message.error).toHaveBeenCalled()
})

it('clear → 状态清空', async () => {
  stubBeanwise()
  useSyncStore.setState({ status: { configured: true, repoUrl: 'x', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false } })
  await useSyncStore.getState().clear()
  expect(useSyncStore.getState().status).toBeNull()
  expect(message.success).toHaveBeenCalledWith('已清除同步配置')
})

// ---- M11：账户库 / 模板在同步范围内 ----

const CONFIGURED = { configured: true, repoUrl: 'https://github.com/a/b', branch: 'main', lastSyncAt: 1, lastError: null, syncing: false }

it('push 成功 → generation 自增 + 账户下拉重载（合并可能已改写账户库）', async () => {
  const api = stubBeanwise()
  useSyncStore.setState({ status: CONFIGURED, generation: 0 })
  await useSyncStore.getState().push()
  expect(useSyncStore.getState().generation).toBe(1)
  expect(api.getAccountConfig).toHaveBeenCalled()
})

it('多文件冲突 → 警告文案含文件标签 + generation 不变（未落盘）', async () => {
  stubBeanwise({
    pushLedger: vi.fn().mockResolvedValue({
      ok: false,
      conflict: true,
      conflicts: [
        { path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' },
        { path: '.beanwise/accounts.json', base: 'b', ours: 'o', theirs: 't' }
      ]
    })
  })
  useSyncStore.setState({ status: CONFIGURED, generation: 0 })
  await useSyncStore.getState().push()
  expect(message.warning).toHaveBeenCalledWith(expect.stringContaining('账本、账户库'))
  expect(useSyncStore.getState().generation).toBe(0)
  expect(useSyncStore.getState().conflict?.files).toHaveLength(2)
})

it('resolveConflict 成功 → generation 自增 + 账户下拉重载', async () => {
  const api = stubBeanwise()
  useSyncStore.setState({ conflict: { files: [{ path: 'main.beancount', base: 'b', ours: 'o', theirs: 't' }] }, generation: 0 })
  const ok = await useSyncStore.getState().resolveConflict([{ path: 'main.beancount', content: 'merged' }])
  expect(ok).toBe(true)
  expect(useSyncStore.getState().generation).toBe(1)
  expect(api.getAccountConfig).toHaveBeenCalled()
})

it('账户库保存成功 → 自动 push（账户库在同步范围内）', async () => {
  const api = stubBeanwise({ saveAccountConfig: vi.fn().mockResolvedValue({ ok: true, accounts: [] }) })
  useSyncStore.setState({ status: CONFIGURED })
  const ok = await useLedgerStore.getState().saveAccountConfig([])
  expect(ok).toBe(true)
  expect(api.pushLedger).toHaveBeenCalled()
})

it('账户库保存失败 → 不触发 push', async () => {
  const api = stubBeanwise({ saveAccountConfig: vi.fn().mockResolvedValue({ ok: false, message: '账户路径不能重复' }) })
  useSyncStore.setState({ status: CONFIGURED })
  const ok = await useLedgerStore.getState().saveAccountConfig([])
  expect(ok).toBe(false)
  expect(api.pushLedger).not.toHaveBeenCalled()
})

// ==================== M12：本机网络配置（代理 + 超时） ====================

it('loadNetwork → 配置落 store；失败则置空并提示', async () => {
  stubBeanwise({ getGitNetwork: vi.fn().mockResolvedValue({ proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 60 }) })
  await useSyncStore.getState().loadNetwork()
  expect(useSyncStore.getState().network).toEqual({ proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 60 })

  stubBeanwise({ getGitNetwork: vi.fn().mockRejectedValue(new Error('boom')) })
  await useSyncStore.getState().loadNetwork()
  expect(useSyncStore.getState().network).toBeNull()
  expect(message.error).toHaveBeenCalled()
})

it('saveNetwork：成功落 store + 提示；校验失败 → ok:false + 错误提示（回显主进程文案）', async () => {
  const api = stubBeanwise({
    saveGitNetwork: vi.fn()
      .mockResolvedValueOnce({ ok: true, network: { proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 30 } })
      .mockResolvedValueOnce({ ok: false, error: '代理地址需带端口，如 http://127.0.0.1:7890' })
  })
  expect(await useSyncStore.getState().saveNetwork({ proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 30 })).toBe(true)
  expect(useSyncStore.getState().network).toEqual({ proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 30 })
  expect(message.success).toHaveBeenCalled()

  expect(await useSyncStore.getState().saveNetwork({ proxyUrl: 'http://127.0.0.1', timeoutSec: 30 })).toBe(false)
  expect(message.error).toHaveBeenCalledWith('代理地址需带端口，如 http://127.0.0.1:7890')
  expect(api.saveGitNetwork).toHaveBeenCalledTimes(2)
})

it('testConnection：把诊断文案原样返回（不当 toast 弹掉），异常也兜成结果对象', async () => {
  stubBeanwise({
    testSyncConnection: vi.fn()
      .mockResolvedValueOnce({ ok: false, message: '无法连接代理 http://127.0.0.1:1（ECONNREFUSED）' })
      .mockRejectedValueOnce(new Error('boom'))
  })
  const failed = await useSyncStore.getState().testConnection('https://github.com/a/b')
  expect(failed).toEqual({ ok: false, message: '无法连接代理 http://127.0.0.1:1（ECONNREFUSED）' })
  expect(message.error).not.toHaveBeenCalled() // 诊断留在弹窗里，不走 toast

  const thrown = await useSyncStore.getState().testConnection()
  expect(thrown.ok).toBe(false)
  expect(thrown.message).toContain('连接测试失败')
})
