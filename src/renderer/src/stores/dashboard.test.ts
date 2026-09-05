/**
 * Dashboard 聚合 store 测试（批次 D Task 2，模式同 reports.test.ts）：
 * 纯函数 sumBalancesByRoot / extractMonthPoints / sumOtherCurrencyAssets 边界 +
 * reloadAll 并行拉取（balances 快照 + 当月收支 + 本期/去年同段 net-worth）与错误吞入 state。
 * 金额累加一律 addDecimalStrings（禁 Number/parseFloat 红线），异常输入 '0' 兜底。
 */
import dayjs from 'dayjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountBalance } from '../../../shared/ipc'

const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import {
  extractMonthPoints,
  sumBalancesByRoot,
  sumOtherCurrencyAssets,
  useDashboardStore
} from './dashboard'

describe('sumBalancesByRoot（顶层类汇总，decimal 精确累加）', () => {
  it('混排 Assets/Liabilities/Equity + 嵌套子账户 → 三值取根节点 rollup，不重复计子树', () => {
    const balances: AccountBalance[] = [
      {
        name: 'Assets',
        balances: [{ currency: 'CNY', number: '1200.50' }],
        children: [{ name: 'Assets:Bank', balances: [{ currency: 'CNY', number: '1200.50' }] }]
      },
      { name: 'Liabilities', balances: [{ currency: 'CNY', number: '-300' }] },
      { name: 'Equity', balances: [{ currency: 'CNY', number: '-900.50' }] },
      { name: 'Income', balances: [{ currency: 'CNY', number: '-100' }] }
    ]
    // addDecimalStrings 规范化输出：去尾随零（'1200.50' → '1200.5'，数值等价）
    expect(sumBalancesByRoot(balances, 'CNY')).toEqual({
      assets: '1200.5',
      liabilities: '-300',
      equity: '-900.5'
    })
  })

  it('多币种：仅累计运营货币，其余币种不计入三值', () => {
    const balances: AccountBalance[] = [
      { name: 'Assets', balances: [{ currency: 'CNY', number: '100' }, { currency: 'USD', number: '50' }] }
    ]
    expect(sumBalancesByRoot(balances, 'CNY').assets).toBe('100')
  })

  it('异常输入 → "0" 兜底（不抛错中断聚合）', () => {
    const balances: AccountBalance[] = [
      { name: 'Assets', balances: [{ currency: 'CNY', number: 'abc' }, { currency: 'CNY', number: '7' }] }
    ]
    expect(sumBalancesByRoot(balances, 'CNY').assets).toBe('7')
  })

  it('缺省运营货币时累计全部币种条目', () => {
    const balances: AccountBalance[] = [
      { name: 'Assets', balances: [{ currency: 'CNY', number: '100' }, { currency: 'USD', number: '50' }] }
    ]
    expect(sumBalancesByRoot(balances).assets).toBe('150')
  })
})

describe('sumOtherCurrencyAssets（其余币种资产单独列出）', () => {
  it('按币种归并 Assets 顶层 rollup 中非运营货币条目，0 值剔除', () => {
    const balances: AccountBalance[] = [
      {
        name: 'Assets',
        balances: [
          { currency: 'CNY', number: '100' },
          { currency: 'USD', number: '10.5' },
          { currency: 'USD', number: '-0.5' },
          { currency: 'JPY', number: '0' }
        ]
      }
    ]
    expect(sumOtherCurrencyAssets(balances, 'CNY')).toEqual([{ currency: 'USD', number: '10' }])
  })
})

describe('extractMonthPoints（当月收支点）', () => {
  const series = [
    { period: '2026-07', income: '80', expense: '30' },
    { period: '2026-08', income: '100', expense: '40' }
  ]

  it('命中当月 → income/expense 点', () => {
    expect(extractMonthPoints(series, '2026-08')).toEqual({ income: '100', expense: '40' })
  })

  it('未命中当月 → null', () => {
    expect(extractMonthPoints(series, '2026-12')).toBeNull()
    expect(extractMonthPoints([], '2026-08')).toBeNull()
  })
})

describe('useDashboardStore.reloadAll', () => {
  type StubApi = {
    getNetWorthReport: ReturnType<typeof vi.fn>
    getBalancesReport: ReturnType<typeof vi.fn>
    getIncomeExpenseReport: ReturnType<typeof vi.fn>
    getCashFlowReport: ReturnType<typeof vi.fn>
    getBreakdownReport: ReturnType<typeof vi.fn>
  }

  function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
    const api: StubApi = {
      getBalancesReport: vi.fn().mockResolvedValue({
        accounts: [
          { name: 'Assets', balances: [{ currency: 'CNY', number: '1200.50' }] },
          { name: 'Liabilities', balances: [{ currency: 'CNY', number: '-300' }] }
        ]
      }),
      getIncomeExpenseReport: vi.fn().mockResolvedValue({
        series: [{ period: dayjs().format('YYYY-MM'), income: '100', expense: '40' }],
        currency: 'CNY'
      }),
      getNetWorthReport: vi.fn().mockResolvedValue({ series: [{ period: '2026-08', assets: '1200.50', liabilities: '-300', netWorth: '900.50' }], currency: 'CNY' }),
      getCashFlowReport: vi.fn().mockResolvedValue({ series: [], currency: 'CNY' }),
      getBreakdownReport: vi.fn().mockResolvedValue({ items: [], total: '0', currency: 'CNY' }),
      ...overrides
    }
    vi.stubGlobal('window', { beanwise: api })
    return api
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
    useDashboardStore.setState({
      loading: false,
      error: null,
      metrics: null,
      series: [],
      prevYearSeries: [],
      otherCurrencies: [],
      hasData: false
    })
    Object.values(message).forEach((m) => m.mockClear())
  })

  it('缺省窗口：并行拉 balances + 当月收支 + 全段本期/去年 net-worth，指标 decimal 精确汇总', async () => {
    const api = stubBeanwise()
    await useDashboardStore.getState().reloadAll()
    const s = useDashboardStore.getState()
    expect(api.getBalancesReport).toHaveBeenCalledWith({})
    expect(api.getIncomeExpenseReport).toHaveBeenCalledWith({ granularity: 'month' })
    expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'month' })
    // 净资产 = 资产 + 负债（Beancount 负债为负）：'1200.50' + '-300'（规范化去尾随零）
    expect(s.metrics).toEqual({
      assets: '1200.5',
      liabilities: '-300',
      netWorth: '900.5',
      monthIncome: '100',
      monthExpense: '40',
      currency: 'CNY'
    })
    expect(s.series).toHaveLength(1)
    expect(s.prevYearSeries).toHaveLength(1)
    expect(s.hasData).toBe(true)
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
  })

  it('自定义窗口：本期按窗口年份拉取，去年同段错位一年；月粒度下序列按月窗口切片', async () => {
    const api = stubBeanwise({
      getNetWorthReport: vi.fn().mockImplementation((params: { startYear?: number; endYear?: number }) =>
        Promise.resolve({
          series: [{ period: `${params.endYear ?? 2026}-03`, assets: '1', liabilities: '0', netWorth: '1' }],
          currency: 'CNY'
        })
      )
    })
    const start = dayjs('2026-01-01')
    const end = dayjs('2026-03-31')
    await useDashboardStore.getState().reloadAll({ start, end, granularity: 'month' })
    expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'month', startYear: 2026, endYear: 2026 })
    expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'month', startYear: 2025, endYear: 2025 })
    // 返回期号 2026-03 落在窗口 [2026-01, 2026-03] 内 → 保留
    expect(useDashboardStore.getState().series).toHaveLength(1)
  })

  it('月粒度窗口切片：窗口外期号被剔除（纯字符串比较，显示层过滤）', async () => {
    stubBeanwise({
      getNetWorthReport: vi.fn().mockResolvedValue({
        series: [
          { period: '2025-12', assets: '1', liabilities: '0', netWorth: '1' },
          { period: '2026-02', assets: '2', liabilities: '0', netWorth: '2' }
        ],
        currency: 'CNY'
      })
    })
    await useDashboardStore.getState().reloadAll({ start: dayjs('2026-01-01'), end: dayjs('2026-03-31'), granularity: 'month' })
    // 本期调用含 2025-12（startYear 2025 起）与 2026-02：切片后仅 2026-02 落窗内
    expect(useDashboardStore.getState().series).toEqual([
      { period: '2026-02', assets: '2', liabilities: '0', netWorth: '2' }
    ])
  })

  it('IPC 失败：错误吞入 state + message.error，不向上抛', async () => {
    stubBeanwise({ getBalancesReport: vi.fn().mockRejectedValue(new Error('boom')) })
    await useDashboardStore.getState().reloadAll()
    const s = useDashboardStore.getState()
    expect(s.loading).toBe(false)
    expect(s.error).toContain('boom')
    expect(message.error).toHaveBeenCalled()
    expect(s.metrics).toBeNull()
  })
})
