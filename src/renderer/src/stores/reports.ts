/**
 * M8 报表 store（T4）：三面板独立数据 + 共享粒度/loading/error + 起止年筛选。
 * 错误吞入 state 由 UI 展示（Alert / message），不向上抛——同 ledger/ai store 约定。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint, ReportGranularity, ReportYearsResult } from '../../../shared/ipc'

interface ReportsState {
  granularity: ReportGranularity
  /** 起始年筛选（null = 不设下界，全量历史） */
  startYear: number | null
  /** 结束年筛选（null = 不设上界，至最新） */
  endYear: number | null
  /** 账本全量年份范围（不随筛选变化，供年份下拉选项稳定） */
  availableYears: ReportYearsResult | null
  netWorth: NetWorthPoint[] | null
  balances: AccountBalance[] | null
  incomeExpense: IncomeExpensePoint[] | null
  loading: boolean
  error: string | null
  currency: string
  setGranularity(g: ReportGranularity): void
  setYearRange(start: number | null, end: number | null): void
  reloadAll(): Promise<void>
}

/** 起止年 → IPC 可选参数（null 不携带，保持旧调用形状 { granularity }） */
function rangeParams(start: number | null, end: number | null): { startYear?: number; endYear?: number } {
  return {
    ...(start !== null ? { startYear: start } : {}),
    ...(end !== null ? { endYear: end } : {})
  }
}

async function loadAll(
  granularity: ReportGranularity,
  startYear: number | null,
  endYear: number | null
): Promise<{
  netWorth: NetWorthPoint[]
  balances: AccountBalance[]
  incomeExpense: IncomeExpensePoint[]
  currency: string
  years: ReportYearsResult
}> {
  const [nw, bal, ie, years] = await Promise.all([
    window.beanwise.getNetWorthReport({ granularity, ...rangeParams(startYear, endYear) }),
    window.beanwise.getBalancesReport(rangeParams(startYear, endYear)),
    window.beanwise.getIncomeExpenseReport({ granularity, ...rangeParams(startYear, endYear) }),
    window.beanwise.getReportYears()
  ])
  return { netWorth: nw.series, balances: bal.accounts, incomeExpense: ie.series, currency: nw.currency, years }
}

export const useReportsStore = create<ReportsState>((set, get) => ({
  granularity: 'month',
  startYear: null,
  endYear: null,
  availableYears: null,
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

  setYearRange: (start, end) => {
    let s = start
    let e = end
    if (s !== null && e !== null && s > e) {
      const tmp = s
      s = e
      e = tmp
    }
    if (s === get().startYear && e === get().endYear) return
    set({ startYear: s, endYear: e })
    void get().reloadAll()
  },

  reloadAll: async () => {
    const g = get().granularity
    const start = get().startYear
    const end = get().endYear
    set({ loading: true, error: null })
    try {
      const r = await loadAll(g, start, end)
      // 粒度或起止年已变：丢弃过期结果（新 reloadAll 在途）
      if (get().granularity !== g || get().startYear !== start || get().endYear !== end) return
      set({
        netWorth: r.netWorth,
        balances: r.balances,
        incomeExpense: r.incomeExpense,
        currency: r.currency,
        availableYears: r.years
      })
    } catch (err) {
      const msg = String(err)
      if (get().granularity !== g || get().startYear !== start || get().endYear !== end) return // 过期请求的失败同样丢弃
      set({ error: msg })
      message.error(`报表加载失败：${msg}`)
    } finally {
      // 仅条件未变时复位 loading（已变则新 reloadAll 在途，loading 归它管）
      if (get().granularity === g && get().startYear === start && get().endYear === end) set({ loading: false })
    }
  }
}))
