/**
 * M8-T2：报表聚合纯函数测试。金额全部十进制字符串精确运算（decimal.ts），
 * 口径：趋势图按运营货币过滤；余额树多币种分行 + 子树 rollup；收支正显示。
 */
import { describe, expect, it } from 'vitest'
import type { AccountBalance } from '../shared/ipc'
import type { PostingRow } from './report-aggregation'
import { buildAccountTree, computeIncomeExpense, computeNetWorth, periodOf } from './report-aggregation'

const rows: PostingRow[] = [
  // 2025-03 收入 + 支出
  { date: '2025-03-01', account: 'Assets:Bank:CNB', number: '10000.00', currency: 'CNY' },
  { date: '2025-03-01', account: 'Income:Salary', number: '-10000.00', currency: 'CNY' },
  { date: '2025-03-05', account: 'Expenses:Food', number: '35.00', currency: 'CNY' },
  { date: '2025-03-05', account: 'Assets:Bank:CNB', number: '-35.00', currency: 'CNY' },
  // 2025-06 支出
  { date: '2025-06-10', account: 'Expenses:Transport', number: '5.00', currency: 'CNY' },
  { date: '2025-06-10', account: 'Assets:Bank:CNB', number: '-5.00', currency: 'CNY' },
  // 2026-01 信用卡支出（负债）
  { date: '2026-01-05', account: 'Expenses:Food', number: '20.00', currency: 'CNY' },
  { date: '2026-01-05', account: 'Liabilities:CreditCard', number: '-20.00', currency: 'CNY' },
  // 2026-02 收入（另一币种，趋势应被过滤）
  { date: '2026-02-01', account: 'Assets:Bank:USD', number: '100.00', currency: 'USD' },
  { date: '2026-02-01', account: 'Income:Salary', number: '-100.00', currency: 'USD' }
]

describe('periodOf', () => {
  it('month → YYYY-MM，year → YYYY', () => {
    expect(periodOf('2026-08-11', 'month')).toBe('2026-08')
    expect(periodOf('2026-08-11', 'year')).toBe('2026')
  })
})

describe('computeNetWorth（按期间累计，运营货币过滤）', () => {
  it('month：逐月累计 assets/liabilities，netWorth = 两者之和', () => {
    const pts = computeNetWorth(rows, 'month', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025-03', '2025-06', '2026-01', '2026-02'])
    // 2025-03 末：assets = 10000 - 35 = 9965，liabilities = 0
    expect(pts[0]).toEqual({ period: '2025-03', assets: '9965', liabilities: '0', netWorth: '9965' })
    // 2025-06 末：assets = 9965 - 5 = 9960
    expect(pts[1]).toEqual({ period: '2025-06', assets: '9960', liabilities: '0', netWorth: '9960' })
    // 2026-01 末：assets 仍 9960，liabilities = -20 → netWorth = 9940
    expect(pts[2]).toEqual({ period: '2026-01', assets: '9960', liabilities: '-20', netWorth: '9940' })
    // 2026-02：USD 行被过滤（currency !== CNY）→ 与 1 月相同
    expect(pts[3]).toEqual({ period: '2026-02', assets: '9960', liabilities: '-20', netWorth: '9940' })
  })

  it('year：按年累计', () => {
    const pts = computeNetWorth(rows, 'year', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025', '2026'])
    expect(pts[0].assets).toBe('9960')
    expect(pts[1]).toEqual({ period: '2026', assets: '9960', liabilities: '-20', netWorth: '9940' })
  })

  it('空输入 → 空数组', () => {
    expect(computeNetWorth([], 'month', 'CNY')).toEqual([])
  })
})

describe('buildAccountTree（叶子余额 + 子树 rollup + 多币种分行）', () => {
  it('按 . 前缀建树，节点 balances 为子树各币种合计', () => {
    const tree = buildAccountTree(rows)
    const assets = tree.find((n) => n.name === 'Assets')!
    expect(assets.balances).toContainEqual({ currency: 'CNY', number: '9960' })
    expect(assets.balances).toContainEqual({ currency: 'USD', number: '100' })
    const bank = assets.children!.find((n) => n.name === 'Assets:Bank')!
    // 子树 rollup：Assets:Bank 下含 USD 叶子（Assets:Bank:USD），故 USD 100 随 rollup 上流
    expect(bank.balances).toEqual([
      { currency: 'CNY', number: '9960' },
      { currency: 'USD', number: '100' }
    ])
    const cnb = bank.children!.find((n) => n.name === 'Assets:Bank:CNB')!
    expect(cnb.balances).toEqual([{ currency: 'CNY', number: '9960' }])
    expect(cnb.children).toBeUndefined()
    // 负债为负
    const liab = tree.find((n) => n.name === 'Liabilities')!
    expect(liab.balances).toEqual([{ currency: 'CNY', number: '-20' }])
    // 收入正显示：Income 行取反聚合，父级 rollup 同步为正
    const income = tree.find((n) => n.name === 'Income')!
    expect(income.balances).toContainEqual({ currency: 'CNY', number: '10000' })
    expect(income.balances).toContainEqual({ currency: 'USD', number: '100' })
    const salary = income.children!.find((n) => n.name === 'Income:Salary')!
    expect(salary.balances).toContainEqual({ currency: 'CNY', number: '10000' })
    expect(salary.balances).toContainEqual({ currency: 'USD', number: '100' })
    // 叶子数 = 聚合账户数（CNY 5 个 + USD 1 个，均不含父级）。
    // 2026-08-11 TDD 修正：简报原 flatMap 两层链只能取到深度 3 节点，漏掉深度 2 叶子
    // （Expenses:*/Income:*/Liabilities:CreditCard），与「叶子 = 全部账户」口径矛盾，改递归收集
    const leaves: AccountBalance[] = []
    const collectLeaves = (nodes: AccountBalance[]): void => {
      for (const n of nodes) {
        if (n.children?.length) collectLeaves(n.children)
        else leaves.push(n)
      }
    }
    collectLeaves(tree)
    expect(leaves.map((n) => n.name)).toEqual([
      'Assets:Bank:CNB',
      'Assets:Bank:USD',
      'Expenses:Food',
      'Expenses:Transport',
      'Income:Salary',
      'Liabilities:CreditCard'
    ])
  })

  it('空输入 → 空数组', () => {
    expect(buildAccountTree([])).toEqual([])
  })
})

describe('computeIncomeExpense（正显示 + 月视图补满 12 个月 + 年过滤）', () => {
  it('month + year=2026：12 个月全量，income = -ΣIncome:*，expense = ΣExpenses:*（索引行支出记正数，正显示）', () => {
    const pts = computeIncomeExpense(rows, 'month', 'CNY', 2026)
    expect(pts).toHaveLength(12)
    const jan = pts.find((p) => p.period === '2026-01')!
    expect(jan).toEqual({ period: '2026-01', income: '0', expense: '20' })
    const feb = pts.find((p) => p.period === '2026-02')!
    expect(feb).toEqual({ period: '2026-02', income: '0', expense: '0' }) // USD 收入被过滤
    expect(pts.every((p) => p.period.startsWith('2026-'))).toBe(true)
  })

  it('year：全历史按年分组，income/expense 正显示', () => {
    const pts = computeIncomeExpense(rows, 'year', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025', '2026'])
    expect(pts[0]).toEqual({ period: '2025', income: '10000', expense: '40' })
    expect(pts[1]).toEqual({ period: '2026', income: '0', expense: '20' })
  })

  it('year 过滤：只算该年', () => {
    const pts = computeIncomeExpense(rows, 'year', 'CNY', 2025)
    expect(pts.map((p) => p.period)).toEqual(['2025'])
    expect(pts[0].expense).toBe('40')
  })

  it('month 粒度缺省 year：直接 throw（函数级防御，handler 必解析）', () => {
    expect(() => computeIncomeExpense(rows, 'month', 'CNY')).toThrow('year')
  })
})
