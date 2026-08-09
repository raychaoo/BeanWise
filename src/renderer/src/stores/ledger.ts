/**
 * 渲染端账本数据唯一入口（zustand，M4）+ M5 编辑器状态。
 * 错误一律吞入 state 由 UI 展示（Alert / message），不向上抛——渲染进程不直连后端，
 * 全部经 preload 白名单 IPC。
 * 编辑器保存状态机（save/forceSave/conflict）落 store actions：node 环境可单测
 * （zustand 无需 DOM）；useEditorSave 仅做选择器 + 动作绑定。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { LedgerEntryRow, LedgerStatus } from '../../../shared/ipc'

export interface EditorConflict {
  diskContent: string
  diskFingerprint: string
}

interface LedgerState {
  status: LedgerStatus | null
  entries: LedgerEntryRow[]
  total: number
  accounts: string[]
  loading: boolean
  error: string | null
  refresh(): Promise<void>
  loadEntries(limit: number, offset: number): Promise<void>
  loadAccounts(): Promise<void>
  setError(error: string | null): void
  // ---- M5 编辑器 ----
  editorContent: string | null
  editorOriginal: string | null
  editorFingerprint: string | null
  editorLoaded: boolean
  editorMissing: boolean
  editorSaving: boolean
  editorConflict: EditorConflict | null
  loadEditorFile(): Promise<void>
  setEditorContent(content: string): void
  saveEditorFile(): Promise<void>
  forceSaveEditorFile(): Promise<void>
  reloadEditorFile(): Promise<void>
  continueEdit(): void
}

export const useLedgerStore = create<LedgerState>((set, get) => {
  /** M5 共享保存执行（save / forceSave 复用；conflict 时以 diskFingerprint 重试覆盖） */
  async function doSaveFile(content: string, expectedFingerprint: string): Promise<void> {
    try {
      const r = await window.beanwise.saveLedgerFile({ content, expectedFingerprint })
      if (r.conflict && r.diskContent !== undefined && r.diskFingerprint !== undefined) {
        set({ editorConflict: { diskContent: r.diskContent, diskFingerprint: r.diskFingerprint } })
        return
      }
      if (!r.ok) {
        message.error(`保存失败：${r.message ?? '校验未通过'}`)
        return
      }
      // M5 终审：基线取本次保存入参快照（勿用最新 editorContent——保存在途按键被吸收为
      // 基线会致 dirty 清零而磁盘无此内容）；指纹同理以本次入参为兜底
      set(() => ({
        editorOriginal: content,
        editorFingerprint: r.fingerprint ?? expectedFingerprint,
        editorConflict: null // forceSave 覆盖成功后冲突解除（brief 测试断言，Step 1 原码缺失）
      }))
      message.success('已保存并校验通过')
      void get().refresh() // 索引联动：Header Tag / 明细视图
    } catch (err) {
      message.error(`保存失败：${String(err)}`)
    } finally {
      set({ editorSaving: false })
    }
  }

  return {
    status: null,
    entries: [],
    total: 0,
    accounts: [],
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true, error: null })
      try {
        const [s, r] = await Promise.all([
          window.beanwise.getLedgerStatus(),
          window.beanwise.listLedgerEntries({ limit: 100 })
        ])
        set({ status: s, entries: r.entries, total: r.total })
      } catch (err) {
        set({ error: String(err) })
      } finally {
        set({ loading: false })
      }
    },

    loadEntries: async (limit, offset) => {
      set({ loading: true, error: null })
      try {
        const r = await window.beanwise.listLedgerEntries({ limit, offset })
        set({ entries: r.entries, total: r.total })
      } catch (err) {
        set({ error: String(err) })
      } finally {
        set({ loading: false })
      }
    },

    loadAccounts: async () => {
      try {
        const r = await window.beanwise.listLedgerAccounts()
        set({ accounts: r.accounts })
      } catch (err) {
        set({ error: String(err) })
      }
    },

    setError: (error) => set({ error }),

    // ---- M5 编辑器 ----
    editorContent: null,
    editorOriginal: null,
    editorFingerprint: null,
    editorLoaded: false,
    editorMissing: false,
    editorSaving: false,
    editorConflict: null,

    loadEditorFile: async () => {
      set({ editorLoaded: false, editorMissing: false })
      try {
        const r = await window.beanwise.readLedgerFile()
        if (!r.ok || r.content === undefined) {
          set({
            editorLoaded: true, editorMissing: true,
            editorContent: null, editorOriginal: null, editorFingerprint: null
          })
          return
        }
        set({
          editorLoaded: true, editorMissing: false,
          editorContent: r.content, editorOriginal: r.content,
          editorFingerprint: r.fingerprint ?? null
        })
      } catch (err) {
        set({
          editorLoaded: true, editorMissing: true,
          editorContent: null, editorOriginal: null, editorFingerprint: null,
          error: String(err)
        })
      }
    },

    setEditorContent: (content) => set({ editorContent: content }),

    saveEditorFile: async () => {
      if (get().editorSaving) return // M5 终审：保存重入守卫（双击 / Ctrl+S 连按不并发双 save）
      const s = get()
      if (s.editorContent === null || s.editorFingerprint === null) return
      if (s.editorContent === s.editorOriginal) {
        message.info('无更改')
        return
      }
      set({ editorSaving: true, editorConflict: null })
      await doSaveFile(s.editorContent, s.editorFingerprint)
    },

    forceSaveEditorFile: async () => {
      if (get().editorSaving) return // M5 终审：保存重入守卫（与 saveEditorFile 共用 editorSaving 互斥）
      const s = get()
      if (s.editorContent === null || !s.editorConflict) return
      set({ editorSaving: true })
      await doSaveFile(s.editorContent, s.editorConflict.diskFingerprint)
    },

    reloadEditorFile: async () => {
      set({ editorConflict: null })
      await get().loadEditorFile()
    },

    continueEdit: () => set({ editorConflict: null })
  }
})
