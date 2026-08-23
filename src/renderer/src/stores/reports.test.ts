/**
 * M8-T4：报表 store 测试（node 环境 mock window.beanwise，模式同 ai.test.ts）。
 * 错误吞入 state 由 UI 展示，不向上抛；粒度/起止年切换触发三面板重载。
 */
import { beforeEach, expect, it, vi } from 'vitest'

const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useReportsStore } from './reports'

type StubApi = {
  getNetWorthReport: ReturnType<typeof vi.fn>
  getBalancesReport: ReturnType<typeof vi.fn>
  getIncomeExpenseReport: ReturnType<typeof vi.fn>
  getReportYears: ReturnType<typeof vi.fn>
}

function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
  const api: StubApi = {
    getNetWorthReport: vi.fn().mockResolvedValue({ series: [], currency: 'CNY' }),
    getBalancesReport: vi.fn().mockResolvedValue({ accounts: [] }),
    getIncomeExpenseReport: vi.fn().mockResolvedValue({ series: [], currency: 'CNY' }),
    getReportYears: vi.fn().mockResolvedValue({ min: 2025, max: 2026 }),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useReportsStore.setState({
    granularity: 'month',
    netWorth: null,
    balances: null,
    incomeExpense: null,
    loading: false,
    error: null,
    currency: '',
    startYear: null,
    endYear: null,
    availableYears: null
  })
  Object.values(message).forEach((m) => m.mockClear())
})

it('reloadAll：三面板并行加载 + 年份范围，数据落 store', async () => {
  const api = stubBeanwise({
    getNetWorthReport: vi.fn().mockResolvedValue({ series: [{ period: '2026-01', assets: '9', liabilities: '0', netWorth: '9' }], currency: 'CNY' }),
    getBalancesReport: vi.fn().mockResolvedValue({ accounts: [{ name: 'Assets', balances: [{ currency: 'CNY', number: '9' }] }] }),
    getIncomeExpenseReport: vi.fn().mockResolvedValue({ series: [{ period: '2026-01', income: '0', expense: '9' }], currency: 'CNY' })
  })
  await useReportsStore.getState().reloadAll()
  const s = useReportsStore.getState()
  expect(s.netWorth).toHaveLength(1)
  expect(s.balances).toHaveLength(1)
  expect(s.incomeExpense).toHaveLength(1)
  expect(s.currency).toBe('CNY')
  expect(s.availableYears).toEqual({ min: 2025, max: 2026 })
  expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'month' })
  expect(api.getIncomeExpenseReport).toHaveBeenCalledWith({ granularity: 'month' })
  expect(api.getBalancesReport).toHaveBeenCalledWith({})
  expect(api.getReportYears).toHaveBeenCalled()
})

it('setGranularity：切换粒度 → 趋势与收支带新粒度重载', async () => {
  const api = stubBeanwise()
  useReportsStore.getState().setGranularity('year')
  expect(useReportsStore.getState().granularity).toBe('year')
  expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'year' })
  expect(api.getIncomeExpenseReport).toHaveBeenCalledWith({ granularity: 'year' })
})

it('setYearRange：设置起止年 → 三面板带范围重载', async () => {
  const api = stubBeanwise()
  useReportsStore.getState().setYearRange(2025, 2026)
  const s = useReportsStore.getState()
  expect(s.startYear).toBe(2025)
  expect(s.endYear).toBe(2026)
  expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'month', startYear: 2025, endYear: 2026 })
  expect(api.getBalancesReport).toHaveBeenCalledWith({ startYear: 2025, endYear: 2026 })
  expect(api.getIncomeExpenseReport).toHaveBeenCalledWith({ granularity: 'month', startYear: 2025, endYear: 2026 })
})

it('setYearRange：start > end 自动对齐', async () => {
  stubBeanwise()
  useReportsStore.getState().setYearRange(2026, 2025)
  const s = useReportsStore.getState()
  expect(s.startYear).toBe(2025)
  expect(s.endYear).toBe(2026)
})

it('setYearRange：允许清空为 null（不设边界）', async () => {
  const api = stubBeanwise()
  useReportsStore.getState().setYearRange(2025, 2026)
  useReportsStore.getState().setYearRange(null, null)
  expect(useReportsStore.getState().startYear).toBeNull()
  expect(useReportsStore.getState().endYear).toBeNull()
  expect(api.getNetWorthReport).toHaveBeenLastCalledWith({ granularity: 'month' })
})

it('加载失败：error 落 store + antd 提示，不抛', async () => {
  stubBeanwise({ getNetWorthReport: vi.fn().mockRejectedValue(new Error('boom')) })
  await useReportsStore.getState().reloadAll()
  expect(useReportsStore.getState().error).toBeTruthy()
  expect(message.error).toHaveBeenCalled()
})
