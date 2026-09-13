/**
 * Dashboard 聚合 store（批次 D Task 2，方案模块 2）：指标卡 + 趋势图数据。
 * 红线：金额聚合一律 addDecimalStrings（src/shared/decimal），禁 Number/parseFloat/SQL SUM；
 * 图表 y 值 Number() 仅在页面显示层做。余额树顶层节点 balances 已是主进程 decimal rollup
 * （report-aggregation.ts buildAccountTree），本 store 只按顶层类汇总，不再下钻防重复计数。
 * 错误吞入 state 由 UI 展示，不向上抛——同 reports/ledger store 约定。
 */
import { message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { create } from 'zustand'
import { addDecimalStrings } from '../../../shared/decimal'
import type {
  AccountBalance,
  BreakdownItem,
  CashFlowPoint,
  IncomeExpensePoint,
  NetWorthPoint,
  ReportNetWorthParams
} from '../../../shared/ipc'
import type { TimeGranularity } from '../hooks/useTimeRange'

/** 趋势筛选窗口（TimeRangeBar 受控值映射；start/end null = 不设界） */
export interface DashboardRange {
  start: Dayjs | null
  end: Dayjs | null
  granularity: TimeGranularity
}

export interface DashboardMetrics {
  assets: string
  liabilities: string
  /** assets + liabilities（Beancount 负债为负） */
  netWorth: string
  monthIncome: string
  monthExpense: string
  currency: string
}

interface DashboardState {
  loading: boolean
  error: string | null
  metrics: DashboardMetrics | null
  /** 本期净资产序列（当前筛选窗口，月/年粒度） */
  series: NetWorthPoint[]
  /** 去年同期序列（窗口错位一年；页面按期号对齐叠加「去年同期」虚线） */
  prevYearSeries: NetWorthPoint[]
  /** 其余币种资产合计（运营货币之外单独列出，方案模块 2 多币种口径） */
  otherCurrencies: Array<{ currency: string; number: string }>
  /** 本期收支对比序列（月粒度，供收支趋势卡；全量当年 12 个月） */
  incomeExpense: IncomeExpensePoint[]
  /** 账户余额树（顶层节点，供资产分布卡） */
  balances: AccountBalance[]
  /** 最近 12 个月现金流量序列（运营货币，按期间升序，供现金流卡） */
  cashFlow: CashFlowPoint[]
  /** 支出类别汇总（顶层段聚合，按金额降序，供去向卡） */
  expenseBreakdown: BreakdownItem[]
  /** 收入类别汇总（顶层段聚合，按金额降序，供来源卡） */
  incomeBreakdown: BreakdownItem[]
  hasData: boolean
  reloadAll(range?: DashboardRange): Promise<void>
}

const ROOT_KEYS: Record<string, 'assets' | 'liabilities' | 'equity'> = {
  Assets: 'assets',
  Liabilities: 'liabilities',
  Equity: 'equity'
}

/** 异常金额 → '0' 兜底（addDecimalStrings 对非法输入抛错，聚合不因脏数据中断） */
function safeAmount(s: string): string {
  try {
    addDecimalStrings(s, '0')
    return s
  } catch {
    return '0'
  }
}

/**
 * 顶层类汇总：遍历顶层节点（balances 已含子树 rollup），按账户首段归类
 * Assets/Liabilities/Equity；operatingCurrency 给定时仅累计该币种（多币种以运营货币为主，
 * 其余币种由 sumOtherCurrencyAssets 单独列出），缺省累计全部币种条目。
 */
export function sumBalancesByRoot(
  balances: AccountBalance[],
  operatingCurrency?: string
): { assets: string; liabilities: string; equity: string } {
  const sums = { assets: '0', liabilities: '0', equity: '0' }
  for (const node of balances) {
    const key = ROOT_KEYS[node.name.split(':')[0]]
    if (!key) continue
    for (const b of node.balances) {
      if (operatingCurrency !== undefined && b.currency !== operatingCurrency) continue
      sums[key] = addDecimalStrings(sums[key], safeAmount(b.number))
    }
  }
  return sums
}

/** 其余币种资产合计：Assets 顶层 rollup 中非运营货币条目按币种归并（0 值剔除） */
export function sumOtherCurrencyAssets(
  balances: AccountBalance[],
  operatingCurrency: string
): Array<{ currency: string; number: string }> {
  const out = new Map<string, string>()
  for (const node of balances) {
    if (node.name.split(':')[0] !== 'Assets') continue
    for (const b of node.balances) {
      if (b.currency === operatingCurrency) continue
      const cur = out.get(b.currency) ?? '0'
      const next = addDecimalStrings(cur, safeAmount(b.number))
      out.set(b.currency, next)
    }
  }
  return [...out.entries()]
    .filter(([, number]) => number !== '0')
    .map(([currency, number]) => ({ currency, number }))
}

/** 当月收支点：period（'YYYY-MM'）命中 → income/expense；未命中 → null */
export function extractMonthPoints(
  points: IncomeExpensePoint[],
  month: string
): { income: string; expense: string } | null {
  const hit = points.find((p) => p.period === month)
  return hit ? { income: hit.income, expense: hit.expense } : null
}

/** 现金流量图窗口：取最近 limit 个月并按期间升序，确保折线从左到右沿时间推进 */
export function latestCashFlowWindow(points: CashFlowPoint[], limit = 12): CashFlowPoint[] {
  if (limit <= 0) return []
  return [...points].sort((a, b) => a.period.localeCompare(b.period)).slice(-limit)
}

/** 期号窗口切片（'YYYY-MM'/'YYYY' 字典序即时间序，纯字符串比较的显示层过滤） */
function filterSeriesWindow(points: NetWorthPoint[], startKey: string | null, endKey: string | null): NetWorthPoint[] {
  if (!startKey && !endKey) return points
  return points.filter((p) => (!startKey || p.period >= startKey) && (!endKey || p.period <= endKey))
}

export const useDashboardStore = create<DashboardState>((set) => {
  let reqSeq = 0 // 过期请求守卫：快速切窗口时丢弃在途旧结果

  return {
    loading: false,
    error: null,
    metrics: null,
    series: [],
    prevYearSeries: [],
    otherCurrencies: [],
    incomeExpense: [],
    balances: [],
    cashFlow: [],
    expenseBreakdown: [],
    incomeBreakdown: [],
    hasData: false,

    reloadAll: async (range = { start: null, end: null, granularity: 'month' }) => {
      const seq = ++reqSeq
      const g = range.granularity
      const windowed = range.start !== null && range.end !== null
      // 本期按窗口年份拉取；去年同段错位一年（方案模块 2「startYear/endYear 错位 12 月对齐」）
      const curParams: ReportNetWorthParams = windowed
        ? { granularity: g, startYear: range.start!.year(), endYear: range.end!.year() }
        : { granularity: g }
      const prevParams: ReportNetWorthParams = windowed
        ? { granularity: g, startYear: range.start!.year() - 1, endYear: range.end!.year() - 1 }
        : { granularity: g }
      const startKey = windowed && g === 'month' ? range.start!.format('YYYY-MM') : windowed ? range.start!.format('YYYY') : null
      const endKey = windowed && g === 'month' ? range.end!.format('YYYY-MM') : windowed ? range.end!.format('YYYY') : null
      // 收支对比口径：运营货币 + 当年全 12 个月（month 粒度缺省 → 当年）
      const ieParams = { granularity: 'month' as const, ...(windowed ? { startYear: range.start!.year(), endYear: range.end!.year() } : {}) }

      set({ loading: true, error: null })
      try {
        const [bal, ie, cur, prev, cf, expBreak, incBreak] = await Promise.all([
          // 余额快照不带界 = 截至最新数据（指标卡为「当前状态」口径）
          window.beanwise.getBalancesReport({}),
          window.beanwise.getIncomeExpenseReport(ieParams),
          window.beanwise.getNetWorthReport(curParams),
          window.beanwise.getNetWorthReport(prevParams),
          // 现金流：拉全量后取最近 12 个月（运营货币，月粒度）
          window.beanwise.getCashFlowReport({ granularity: 'month' }),
          // 收支类别汇总（运营货币，全量）
          window.beanwise.getBreakdownReport({ flow: 'expense' }),
          window.beanwise.getBreakdownReport({ flow: 'income' })
        ])
        if (seq !== reqSeq) return // 过期请求：结果丢弃
        const currency = cur.currency
        const sums = sumBalancesByRoot(bal.accounts, currency)
        const monthPoint = extractMonthPoints(ie.series, dayjs().format('YYYY-MM'))
        set({
          metrics: {
            assets: sums.assets,
            liabilities: sums.liabilities,
            netWorth: addDecimalStrings(sums.assets, sums.liabilities),
            monthIncome: monthPoint?.income ?? '0',
            monthExpense: monthPoint?.expense ?? '0',
            currency
          },
          series: filterSeriesWindow(cur.series, startKey, endKey),
          prevYearSeries: prev.series,
          otherCurrencies: sumOtherCurrencyAssets(bal.accounts, currency),
          incomeExpense: ie.series,
          balances: bal.accounts,
          cashFlow: latestCashFlowWindow(cf.series),
          expenseBreakdown: expBreak.items,
          incomeBreakdown: incBreak.items,
          hasData: bal.accounts.length > 0 || cur.series.length > 0 || ie.series.length > 0,
          loading: false
        })
      } catch (err) {
        if (seq !== reqSeq) return
        const msg = String(err)
        set({ error: msg, loading: false })
        message.error(`总览加载失败：${msg}`)
      }
    }
  }
})
