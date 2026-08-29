/**
 * 录入表单 dirty 微 store（批次 A 契约）：批次 B 在 EntryFormView 的
 * onValuesChange / 提交成功处调用 setDirty；批次 C 的账本切换确认只读消费。
 */
import { create } from 'zustand'

interface EntryFormState {
  dirty: boolean
  setDirty(v: boolean): void
}

export const useEntryFormStore = create<EntryFormState>((set) => ({
  dirty: false,
  setDirty: (v) => set({ dirty: v })
}))
