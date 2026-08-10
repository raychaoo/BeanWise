import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 工厂在 import 求值期（本文件模块体执行前）解析，直接引用顶层 const 会 TDZ
// ReferenceError（vitest 4.1.10 实测）；vi.hoisted 将 message 提前到 import 之前初始化。
const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useLedgerStore } from './ledger'

type StubApi = {
  readLedgerFile: ReturnType<typeof vi.fn>
  saveLedgerFile: ReturnType<typeof vi.fn>
  getLedgerStatus: ReturnType<typeof vi.fn>
  listLedgerEntries: ReturnType<typeof vi.fn>
  listLedgerAccounts: ReturnType<typeof vi.fn>
  refreshLedgerIndex: ReturnType<typeof vi.fn>
  getSyncStatus: ReturnType<typeof vi.fn>
  pushLedger: ReturnType<typeof vi.fn>
}

function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
  const api: StubApi = {
    readLedgerFile: vi.fn(),
    saveLedgerFile: vi.fn(),
    getLedgerStatus: vi.fn().mockResolvedValue(null),
    listLedgerEntries: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    listLedgerAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
    refreshLedgerIndex: vi.fn().mockResolvedValue({ changed: false, status: 'ok', entryCount: 0, errorCount: 0 }),
    getSyncStatus: vi.fn().mockResolvedValue({ configured: false, lastSyncAt: null, lastError: null, syncing: false }),
    pushLedger: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

const F = 'f'.repeat(64)

beforeEach(() => {
  vi.unstubAllGlobals()
  useLedgerStore.setState({
    status: null, entries: [], total: 0, accounts: [], loading: false, error: null,
    editorContent: null, editorOriginal: null, editorFingerprint: null,
    editorLoaded: false, editorMissing: false, editorSaving: false, editorConflict: null
  })
  message.success.mockClear()
  message.error.mockClear()
  message.info.mockClear()
})

it('loadEditorFile：成功 → 内容 + 基线 + 指纹', async () => {
  stubBeanwise({ readLedgerFile: vi.fn().mockResolvedValue({ ok: true, content: '2026-01-01 open Assets:X', fingerprint: F }) })
  await useLedgerStore.getState().loadEditorFile()
  const s = useLedgerStore.getState()
  expect(s.editorLoaded).toBe(true)
  expect(s.editorMissing).toBe(false)
  expect(s.editorContent).toBe('2026-01-01 open Assets:X')
  expect(s.editorOriginal).toBe(s.editorContent)
  expect(s.editorFingerprint).toBe(F)
})

it('loadEditorFile：文件不存在 → missing 空态', async () => {
  stubBeanwise({ readLedgerFile: vi.fn().mockResolvedValue({ ok: false, message: '账本文件不存在' }) })
  await useLedgerStore.getState().loadEditorFile()
  const s = useLedgerStore.getState()
  expect(s.editorMissing).toBe(true)
  expect(s.editorContent).toBeNull()
})

it('saveEditorFile：无更改 → info 提示，不发 IPC', async () => {
  const api = stubBeanwise()
  useLedgerStore.setState({ editorContent: 'x', editorOriginal: 'x', editorFingerprint: F })
  await useLedgerStore.getState().saveEditorFile()
  expect(api.saveLedgerFile).not.toHaveBeenCalled()
  expect(message.info).toHaveBeenCalledWith('无更改')
})

it('saveEditorFile：成功 → 基线更新 + 成功提示 + refresh 联动', async () => {
  const api = stubBeanwise({
    saveLedgerFile: vi.fn().mockResolvedValue({ ok: true, fingerprint: 'b'.repeat(64), status: 'ok', entryCount: 6, errorCount: 0 })
  })
  useLedgerStore.setState({ editorContent: 'new', editorOriginal: 'old', editorFingerprint: F })
  await useLedgerStore.getState().saveEditorFile()
  expect(api.saveLedgerFile).toHaveBeenCalledWith({ content: 'new', expectedFingerprint: F })
  const s = useLedgerStore.getState()
  expect(s.editorOriginal).toBe('new')
  expect(s.editorFingerprint).toBe('b'.repeat(64))
  expect(s.editorSaving).toBe(false)
  expect(message.success).toHaveBeenCalledWith('已保存并校验通过')
  expect(api.getLedgerStatus).toHaveBeenCalled() // refresh 联动
})

it('saveEditorFile：保存中重入 → 直接 return，不并发双 save（M5 终审）', async () => {
  const api = stubBeanwise({
    saveLedgerFile: vi.fn().mockResolvedValue({ ok: true, fingerprint: 'b'.repeat(64), status: 'ok', entryCount: 6, errorCount: 0 })
  })
  useLedgerStore.setState({ editorContent: 'new', editorOriginal: 'old', editorFingerprint: F })
  const p1 = useLedgerStore.getState().saveEditorFile() // 不 await：模拟保存在途（editorSaving 已同步置 true）
  await useLedgerStore.getState().saveEditorFile()      // 重入调用：应被守卫拦截
  expect(api.saveLedgerFile).toHaveBeenCalledTimes(1)
  await p1
})

it('saveEditorFile：冲突 → editorConflict 落 store，不发成功提示', async () => {
  stubBeanwise({
    saveLedgerFile: vi.fn().mockResolvedValue({ ok: false, conflict: true, diskContent: 'disk', diskFingerprint: 'c'.repeat(64) })
  })
  useLedgerStore.setState({ editorContent: 'local', editorOriginal: 'old', editorFingerprint: F })
  await useLedgerStore.getState().saveEditorFile()
  expect(useLedgerStore.getState().editorConflict).toEqual({ diskContent: 'disk', diskFingerprint: 'c'.repeat(64) })
  expect(message.success).not.toHaveBeenCalled()
})

it('saveEditorFile：校验失败 → 错误提示，基线不动', async () => {
  stubBeanwise({ saveLedgerFile: vi.fn().mockResolvedValue({ ok: false, message: 'Transaction does not balance' }) })
  useLedgerStore.setState({ editorContent: 'bad', editorOriginal: 'old', editorFingerprint: F })
  await useLedgerStore.getState().saveEditorFile()
  expect(message.error).toHaveBeenCalledWith('保存失败：Transaction does not balance')
  expect(useLedgerStore.getState().editorOriginal).toBe('old')
})

it('forceSaveEditorFile：以 diskFingerprint 重试覆盖 → 冲突清除', async () => {
  const api = stubBeanwise({
    saveLedgerFile: vi.fn().mockResolvedValue({ ok: true, fingerprint: 'b'.repeat(64), status: 'ok', entryCount: 6, errorCount: 0 })
  })
  useLedgerStore.setState({
    editorContent: 'local', editorOriginal: 'old', editorFingerprint: F,
    editorConflict: { diskContent: 'disk', diskFingerprint: 'c'.repeat(64) }
  })
  await useLedgerStore.getState().forceSaveEditorFile()
  expect(api.saveLedgerFile).toHaveBeenCalledWith({ content: 'local', expectedFingerprint: 'c'.repeat(64) })
  expect(useLedgerStore.getState().editorConflict).toBeNull()
})

it('reloadEditorFile：清冲突 + 重读文件', async () => {
  stubBeanwise({ readLedgerFile: vi.fn().mockResolvedValue({ ok: true, content: 'disk-now', fingerprint: F }) })
  useLedgerStore.setState({ editorConflict: { diskContent: 'disk', diskFingerprint: 'c'.repeat(64) } })
  await useLedgerStore.getState().reloadEditorFile()
  expect(useLedgerStore.getState().editorConflict).toBeNull()
  expect(useLedgerStore.getState().editorContent).toBe('disk-now')
})

it('saveEditorFile 成功 → 自动触发 syncStore.push', async () => {
  const api = stubBeanwise({
    saveLedgerFile: vi.fn().mockResolvedValue({ ok: true, fingerprint: 'b'.repeat(64), status: 'ok', entryCount: 6, errorCount: 0 }),
    pushLedger: vi.fn().mockResolvedValue({ ok: true })
  })
  useLedgerStore.setState({ editorContent: 'new', editorOriginal: 'old', editorFingerprint: F })
  await useLedgerStore.getState().saveEditorFile()
  expect(api.saveLedgerFile).toHaveBeenCalled()
  expect(api.pushLedger).toHaveBeenCalled()
})
