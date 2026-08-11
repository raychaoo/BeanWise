/**
 * M8 报表 store（T4）：三面板独立数据 + 共享粒度/loading/error。
 * 错误吞入 state 由 UI 展示（Alert / message），不向上抛——同 ledger/ai store 约定。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint, ReportGranularity } from '../../../shared/ipc'

interface ReportsState {
  granularity: ReportGranularity
  netWorth: NetWorthPoint[] | null
  balances: AccountBalance[] | null
  incomeExpense: IncomeExpensePoint[] | null
  loading: boolean
  error: string | null
  currency: string
  setGranularity(g: ReportGranularity): void
  reloadAll(): Promise<void>
}

async function loadAll(granularity: ReportGranularity): Promise<{
  netWorth: NetWorthPoint[]
  balances: AccountBalance[]
  incomeExpense: IncomeExpensePoint[]
  currency: string
}> {
  const [nw, bal, ie] = await Promise.all([
    window.beanwise.getNetWorthReport({ granularity }),
    window.beanwise.getBalancesReport(),
    window.beanwise.getIncomeExpenseReport({ granularity })
  ])
  return { netWorth: nw.series, balances: bal.accounts, incomeExpense: ie.series, currency: nw.currency }
}

export const useReportsStore = create<ReportsState>((set, get) => ({
  granularity: 'month',
  netWorth: null,
  balances: null,
  incomeExpense: null,
  loading: false,
  error: null,
  currency: '',

  setGranularity: (g) => {
    if (g === get().granularity) return
    set({ granularity: g })
    void get().reloadAll()
  },

  reloadAll: async () => {
    const g = get().granularity
    set({ loading: true, error: null })
    try {
      const r = await loadAll(g)
      if (get().granularity !== g) return // 粒度已切换：丢弃过期结果（新 reloadAll 在途）
      set({ netWorth: r.netWorth, balances: r.balances, incomeExpense: r.incomeExpense, currency: r.currency })
    } catch (err) {
      const msg = String(err)
      if (get().granularity !== g) return // 过期请求的失败同样丢弃
      set({ error: msg })
      message.error(`报表加载失败：${msg}`)
    } finally {
      // 仅粒度未变时复位 loading（粒度已变则新 reloadAll 在途，loading 归它管）
      if (get().granularity === g) set({ loading: false })
    }
  }
}))
