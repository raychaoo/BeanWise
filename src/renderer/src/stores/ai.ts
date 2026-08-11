/**
 * M7：AI 配置状态（zustand，模式同 sync store——actions 可 node 单测）。
 * 渲染端不保存 API Key：saveConfig 仅经 ai:save-config 通道上传（Key 不落任何 state）。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { AiStatus } from '../../../shared/ipc'

interface AiState {
  status: AiStatus | null
  loadStatus(): Promise<void>
  saveConfig(apiKey: string): Promise<boolean>
  clearConfig(): Promise<void>
}

export const useAiStore = create<AiState>((set) => ({
  status: null,

  loadStatus: async () => {
    try {
      const status = await window.beanwise.getAiStatus()
      set({ status })
    } catch (err) {
      set({ status: null })
      message.error(`读取 AI 状态失败：${String(err)}`)
    }
  },

  saveConfig: async (apiKey) => {
    try {
      const r = await window.beanwise.saveAiConfig({ apiKey })
      if (!r.ok) {
        message.error(`保存失败：${r.error ?? '未知错误'}`)
        return false
      }
      await useAiStore.getState().loadStatus()
      message.success('AI 配置已保存')
      return true
    } catch (err) {
      message.error(`保存失败：${String(err)}`)
      return false
    }
  },

  clearConfig: async () => {
    try {
      await window.beanwise.clearAiConfig()
      await useAiStore.getState().loadStatus()
      message.success('已清除 AI 配置')
    } catch (err) {
      message.error(`清除失败：${String(err)}`)
    }
  }
}))
