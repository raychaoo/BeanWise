/**
 * 渲染端账本数据唯一入口（zustand，M4）。
 * 错误一律吞入 state 由 UI 展示（Alert / message），不向上抛——渲染进程不直连后端，
 * 全部经 preload 白名单 IPC。
 */
import { create } from 'zustand'
import type { LedgerEntryRow, LedgerStatus } from '../../../shared/ipc'

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
}

export const useLedgerStore = create<LedgerState>((set) => ({
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

  setError: (error) => set({ error })
}))
