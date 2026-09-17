/**
 * M6/M11：git 同步状态（zustand，模式同 ledgerStore——actions 可 node 单测）。
 * 保存成功 → 自动 push（fire-and-forget，失败不阻塞保存）；冲突快照（**逐文件**，M11 起）
 * 落 store 供 ConflictView 消费；PAT 只经 configure 通道上传，任何 state 不保存 PAT。
 *
 * M11：同步范围含账户库与 Excel 模板 → 任何一次成功同步（configure/push/pull/resolve）都可能
 * 改写了 `.beanwise/accounts.json`，故除了 ledgerStore.refresh()（status + entries）还要
 * loadAccounts()，并用 generation 让账户页 / 模板列表等「按需加载」的视图重新拉取。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { DetectIdentityResult, GitIdentityState, GitNetworkConfig, ResolveFileParam, SaveIdentityParams, SyncFileConflict, SyncStatus, TestConnectionResult } from '../../../shared/ipc'
import { describeConflicts } from '../../../shared/sync-files'
import { useLedgerStore } from './ledger'

export interface SyncConflict {
  files: SyncFileConflict[]
}

interface SyncState {
  status: SyncStatus | null
  conflict: SyncConflict | null
  syncing: boolean
  /** 成功合并/落盘一次自增（视图级重载信号：账户页、Excel 模板列表） */
  generation: number
  /** M12 本机网络配置（代理 + 超时）——机器级，与工作目录无关 */
  network: GitNetworkConfig | null
  /** M13 提交人身份（手填值机器级 + 识别缓存按工作目录隔离 + 推导出的生效值） */
  identity: GitIdentityState | null
  loadStatus(): Promise<void>
  configure(repoUrl: string, pat: string): Promise<boolean>
  push(): Promise<void>
  pull(): Promise<void>
  resolveConflict(resolved: ResolveFileParam[]): Promise<boolean>
  clear(): Promise<void>
  loadNetwork(): Promise<void>
  saveNetwork(config: GitNetworkConfig): Promise<boolean>
  testConnection(repoUrl?: string): Promise<TestConnectionResult>
  loadIdentity(): Promise<void>
  saveIdentity(params: SaveIdentityParams): Promise<boolean>
  detectIdentity(): Promise<DetectIdentityResult>
}

/** 响应是否携带可用的冲突快照（conflict:true 但载荷缺失视为普通失败） */
function conflictPayload(r: { conflict?: boolean; conflicts?: SyncFileConflict[] }): SyncFileConflict[] | null {
  return r.conflict === true && Array.isArray(r.conflicts) && r.conflicts.length > 0 ? r.conflicts : null
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: null,
  conflict: null,
  syncing: false,
  generation: 0,
  network: null,
  identity: null,

  loadStatus: async () => {
    try {
      const status = await window.beanwise.getSyncStatus()
      set({ status, syncing: status?.syncing ?? false })
    } catch (err) {
      set({ status: null })
      message.error(`读取同步状态失败：${String(err)}`)
    }
  },

  configure: async (repoUrl, pat) => {
    set({ syncing: true })
    try {
      const r = await window.beanwise.configureSync({ repoUrl, pat })
      const conflicts = conflictPayload(r)
      if (conflicts) {
        // 场景 C 接管冲突：直接进合并视图
        set({ conflict: { files: conflicts } })
        message.warning('本地与远端内容不一致，请在三路合并视图处理')
        return false
      }
      if (!r.ok) {
        message.error(`同步配置失败：${r.error ?? '未知错误'}`)
        return false
      }
      set((s) => ({ status: r.status ?? null, generation: s.generation + 1 }))
      message.success('同步配置成功')
      // 场景 B clone 会把远端账户库/模板带到本地 → 账户下拉必须重新拉取
      void useLedgerStore.getState().loadAccounts()
      return true
    } catch (err) {
      message.error(`同步配置失败：${String(err)}`)
      return false
    } finally {
      set({ syncing: false })
    }
  },

  push: async () => {
    // M6 终审（审查 I-1）：未配置同步时自动 push 静默跳过——未配置是默认态，每次保存
    // 都弹「同步失败」warning 会打扰且与「已保存并校验通过」矛盾；手动 pull 未配置仍报错（用户主动请求）
    const status = get().status
    if (!status?.configured) return
    if (get().syncing) return
    set({ syncing: true })
    try {
      const r = await window.beanwise.pushLedger()
      const conflicts = conflictPayload(r)
      if (conflicts) {
        set({ conflict: { files: conflicts } })
        message.warning(`同步冲突（${describeConflicts(conflicts)}）：请到「合并」视图处理`)
      } else if (!r.ok) {
        message.warning(`同步失败：${r.message ?? '未知错误'}`)
      } else {
        // 合并已落盘 → 清陈旧冲突快照，防其覆写刚落盘内容（M6 终审修复 I-2b）
        set((s) => ({ conflict: null, generation: s.generation + 1 }))
        message.success('已同步到远端')
        void useLedgerStore.getState().refresh() // 自动合并落盘 → 索引联动
        void useLedgerStore.getState().loadAccounts() // 账户库可能已被合并改写
      }
      void get().loadStatus()
    } catch (err) {
      message.warning(`同步失败：${String(err)}`)
    } finally {
      set({ syncing: false })
    }
  },

  pull: async () => {
    if (get().syncing) return
    set({ syncing: true })
    try {
      const r = await window.beanwise.pullLedger()
      const conflicts = conflictPayload(r)
      if (conflicts) {
        set({ conflict: { files: conflicts } })
        message.warning(`同步冲突（${describeConflicts(conflicts)}）：请到「合并」视图处理`)
      } else if (!r.ok) {
        message.error(`拉取失败：${r.message ?? '未知错误'}`)
      } else {
        set((s) => ({ conflict: null, generation: s.generation + 1 })) // 同上：合并落盘后清陈旧快照（M6 终审修复 I-2b）
        message.success('已拉取远端更新')
        void useLedgerStore.getState().refresh()
        void useLedgerStore.getState().loadAccounts()
      }
      void get().loadStatus()
    } catch (err) {
      message.error(`拉取失败：${String(err)}`)
    } finally {
      set({ syncing: false })
    }
  },

  resolveConflict: async (resolved) => {
    set({ syncing: true })
    try {
      const r = await window.beanwise.resolveSyncConflict({ resolved })
      if (!r.ok) {
        message.error(`合并提交失败：${r.message ?? '校验未通过'}`)
        return false
      }
      set((s) => ({ conflict: null, generation: s.generation + 1 }))
      message.success('冲突已解决并推送')
      void useLedgerStore.getState().refresh()
      void useLedgerStore.getState().loadAccounts()
      void get().loadStatus()
      return true
    } catch (err) {
      message.error(`合并提交失败：${String(err)}`)
      return false
    } finally {
      set({ syncing: false })
    }
  },

  clear: async () => {
    try {
      await window.beanwise.clearSync()
      set({ status: null, conflict: null })
      message.success('已清除同步配置')
    } catch (err) {
      message.error(`清除失败：${String(err)}`)
    }
  },

  // ---- M12 本机网络配置（代理 + 超时）：机器级，与工作目录/账本仓库无关 ----

  loadNetwork: async () => {
    try {
      set({ network: await window.beanwise.getGitNetwork() })
    } catch (err) {
      set({ network: null })
      message.error(`读取网络设置失败：${String(err)}`)
    }
  },

  saveNetwork: async (config) => {
    try {
      const r = await window.beanwise.saveGitNetwork(config)
      if (!r.ok) {
        message.error(r.error ?? '网络设置保存失败')
        return false
      }
      set({ network: r.network ?? config })
      message.success('网络设置已保存')
      return true
    } catch (err) {
      message.error(`网络设置保存失败：${String(err)}`)
      return false
    }
  },

  /**
   * 连接测试。**不弹 toast**——返回的诊断文案（超时/代理不可达/认证失败）要留在弹窗里
   * 供用户对着改代理地址，几秒即散的 toast 是错误介质。
   */
  testConnection: async (repoUrl) => {
    try {
      return await window.beanwise.testSyncConnection({ repoUrl })
    } catch (err) {
      return { ok: false, message: `连接测试失败：${String(err)}` }
    }
  },

  // ---- M13 提交人身份：手填值机器级，识别缓存按工作目录隔离（见 stores/git-identity-store） ----

  /** 打开弹窗时拉当前身份（生效值由主进程推导，渲染端只展示） */
  loadIdentity: async () => {
    try {
      set({ identity: await window.beanwise.getGitIdentity() })
    } catch (err) {
      set({ identity: null })
      message.error(`读取提交人身份失败：${String(err)}`)
    }
  },

  saveIdentity: async (params) => {
    try {
      const r = await window.beanwise.saveGitIdentity(params)
      if (!r.ok) {
        message.error(r.error ?? '提交人身份保存失败')
        return false
      }
      if (r.state) set({ identity: r.state })
      message.success('提交人身份已保存（只影响之后的提交）')
      return true
    } catch (err) {
      message.error(`提交人身份保存失败：${String(err)}`)
      return false
    }
  },

  /**
   * 识别 GitHub 身份（用本工作目录的 PAT，走已配置的代理）。
   * **不弹 toast**——诊断文案（代理不可达/未放行/PAT 无效/超时）要留在弹窗里，同 testConnection。
   */
  detectIdentity: async () => {
    try {
      const r = await window.beanwise.detectGitIdentity()
      if (r.state) set({ identity: r.state })
      return r
    } catch (err) {
      return { ok: false, message: `识别失败：${String(err)}` }
    }
  }
}))
