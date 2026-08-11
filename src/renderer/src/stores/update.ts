/**
 * M8 更新 store（T6）：状态 = window.beanwise.getUpdateStatus() 初始拉取 +
 * onUpdateStatusChanged 事件推送（main → renderer）。check 失败提示不抛。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { UpdateState } from '../../../shared/ipc'

interface UpdateStoreState {
  state: UpdateState | null
  init(): Promise<void>
  check(): Promise<boolean>
  install(): Promise<void>
}

let unsubscribed = false

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  state: null,

  init: async () => {
    try {
      const state = await window.beanwise.getUpdateStatus()
      set({ state })
    } catch (err) {
      set({ state: { status: 'error', currentVersion: '', error: String(err) } })
    }
    // 事件推送订阅（main → renderer）；幂等：仅订阅一次
    if (!unsubscribed) {
      unsubscribed = true
      window.beanwise.onUpdateStatusChanged((state) => set({ state }))
    }
  },

  check: async () => {
    try {
      const r = await window.beanwise.checkForUpdates()
      if (!r.ok) {
        message.error(`检查更新失败：${r.message ?? '未知错误'}`)
        return false
      }
      return true
    } catch (err) {
      message.error(`检查更新失败：${String(err)}`)
      return false
    }
  },

  install: async () => {
    try {
      await window.beanwise.installUpdate()
    } catch (err) {
      message.error(`安装失败：${String(err)}`)
    }
  }
}))
