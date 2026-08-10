import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  getLedgerStatus: ReturnType<typeof vi.fn>
  listLedgerEntries: ReturnType<typeof vi.fn>
  listLedgerAccounts: ReturnType<typeof vi.fn>
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
    getLedgerStatus: vi.fn().mockResolvedValue(null),
    listLedgerEntries: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    listLedgerAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
    refreshLedgerIndex: vi.fn().mockResolvedValue({ changed: false, status: 'ok', entryCount: 0, errorCount: 0 }),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useSyncStore.setState({ status: null, conflict: null, syncing: false })
  useLedgerStore.setState({
    status: null, entries: [], total: 0, accounts: [], loading: false, error: null,
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
  stubBeanwise({ configureSync: vi.fn().mockResolvedValue({ ok: false, conflict: true, base: '', ours: 'local', theirs: 'remote' }) })
  const ok = await useSyncStore.getState().configure('https://github.com/a/b', 'pat')
  expect(ok).toBe(false)
  expect(useSyncStore.getState().conflict).toEqual({ base: '', ours: 'local', theirs: 'remote' })
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
  await useSyncStore.getState().push()
  expect(api.pushLedger).toHaveBeenCalled()
  expect(message.success).toHaveBeenCalledWith('已同步到远端')
  expect(api.getLedgerStatus).toHaveBeenCalled() // refresh 联动
})

it('push 冲突 → conflict 落 store + 警告提示', async () => {
  stubBeanwise({ pushLedger: vi.fn().mockResolvedValue({ ok: false, conflict: true, base: 'b', ours: 'o', theirs: 't' }) })
  await useSyncStore.getState().push()
  expect(useSyncStore.getState().conflict).toEqual({ base: 'b', ours: 'o', theirs: 't' })
  expect(message.warning).toHaveBeenCalled()
  expect(message.success).not.toHaveBeenCalled()
})

it('push 失败（网络）→ 警告提示 + lastError 状态刷新', async () => {
  stubBeanwise({ pushLedger: vi.fn().mockResolvedValue({ ok: false, message: '连接超时' }) })
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
  useSyncStore.setState({ conflict: { base: 'b', ours: 'o', theirs: 't' } })
  const ok = await useSyncStore.getState().resolveConflict('merged')
  expect(ok).toBe(true)
  expect(api.resolveSyncConflict).toHaveBeenCalledWith({ content: 'merged' })
  expect(useSyncStore.getState().conflict).toBeNull()
  expect(message.success).toHaveBeenCalled()
})

it('resolveConflict 校验失败 → 错误提示 + 冲突保留', async () => {
  stubBeanwise({ resolveSyncConflict: vi.fn().mockResolvedValue({ ok: false, message: 'Transaction does not balance' }) })
  useSyncStore.setState({ conflict: { base: 'b', ours: 'o', theirs: 't' } })
  const ok = await useSyncStore.getState().resolveConflict('bad')
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

it('保存成功自动触发 push（ledger-editor 链路）', async () => {
  // 由 ledger-editor.test.ts 追加（见 Step 4）
})
