/**
 * M8-T2：报表聚合纯函数测试。金额全部十进制字符串精确运算（decimal.ts），
 * 口径：趋势图按运营货币过滤；余额树多币种分行 + 子树 rollup；收支正显示。
 */
import { describe, expect, it } from 'vitest'
import type { AccountBalance } from '../../shared/ipc'
import type { PostingRow } from './report-aggregation'
import { buildAccountTree, computeCashFlow, computeIncomeExpense, computeNetWorth, computeTrialBalance, periodKey } from './report-aggregation'
import type { CashFlowPostingRow } from './report-aggregation'

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

describe('periodKey（日/周/月/年）', () => {
  it('day → 日期原值；month → YYYY-MM，year → YYYY', () => {
    expect(periodKey('2026-08-11', 'day')).toBe('2026-08-11')
    expect(periodKey('2026-08-11', 'month')).toBe('2026-08')
    expect(periodKey('2026-08-11', 'year')).toBe('2026')
  })

  it('week → ISO 周标签 YYYY-Www（周一起始）', () => {
    expect(periodKey('2026-08-10', 'week')).toBe('2026-W33') // 周一
    expect(periodKey('2026-08-11', 'week')).toBe('2026-W33') // 周二
  })

  it('week 跨年周界：2026-12-29 属 2026-W53，2027-01-01/01-03 同属 2026-W53，2027-01-04 属 2027-W01（ISO 周年规则）', () => {
    expect(periodKey('2026-12-28', 'week')).toBe('2026-W53') // 周一
    expect(periodKey('2026-12-29', 'week')).toBe('2026-W53')
    expect(periodKey('2026-12-31', 'week')).toBe('2026-W53')
    expect(periodKey('2027-01-01', 'week')).toBe('2026-W53') // 2027-01-01 周五，ISO 属上一周年的最后一周
    expect(periodKey('2027-01-03', 'week')).toBe('2026-W53') // 周日
    expect(periodKey('2027-01-04', 'week')).toBe('2027-W01') // 周一
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

  it('起止年筛选：仅输出范围内期间，累计含范围前历史', () => {
    const pts = computeNetWorth(rows, 'month', 'CNY', { startYear: 2026 })
    expect(pts.map((p) => p.period)).toEqual(['2026-01', '2026-02'])
    // 2026-01 累计含 2025 全历史：assets = 9960，liabilities = -20
    expect(pts[0]).toEqual({ period: '2026-01', assets: '9960', liabilities: '-20', netWorth: '9940' })
    expect(pts[1]).toEqual({ period: '2026-02', assets: '9960', liabilities: '-20', netWorth: '9940' })
  })

  it('endYear 筛选：不输出结束年之后期间', () => {
    const pts = computeNetWorth(rows, 'month', 'CNY', { startYear: 2025, endYear: 2025 })
    expect(pts.map((p) => p.period)).toEqual(['2025-03', '2025-06'])
    expect(pts[1]).toEqual({ period: '2025-06', assets: '9960', liabilities: '0', netWorth: '9960' })
  })

  it('空输入 → 空数组', () => {
    expect(computeNetWorth([], 'month', 'CNY')).toEqual([])
  })
})

describe('computeNetWorth（日/周粒度）', () => {
  it('day：逐日累计 assets/liabilities（USD 行被过滤，该日仍输出与上期持平点）', () => {
    const pts = computeNetWorth(rows, 'day', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025-03-01', '2025-03-05', '2025-06-10', '2026-01-05', '2026-02-01'])
    expect(pts[0]).toEqual({ period: '2025-03-01', assets: '10000', liabilities: '0', netWorth: '10000' })
    expect(pts[1]).toEqual({ period: '2025-03-05', assets: '9965', liabilities: '0', netWorth: '9965' })
    expect(pts[2]).toEqual({ period: '2025-06-10', assets: '9960', liabilities: '0', netWorth: '9960' })
    expect(pts[3]).toEqual({ period: '2026-01-05', assets: '9960', liabilities: '-20', netWorth: '9940' })
    // 2026-02-01 全为 USD：币种过滤后仍输出与 01-05 持平的点
    expect(pts[4]).toEqual({ period: '2026-02-01', assets: '9960', liabilities: '-20', netWorth: '9940' })
  })

  it('week：按 ISO 周累计，跨年周界归属 ISO 周年', () => {
    const wk: PostingRow[] = [
      { date: '2026-12-28', account: 'Assets:Bank:CNB', number: '100', currency: 'CNY' },
      { date: '2026-12-28', account: 'Income:Salary', number: '-100', currency: 'CNY' },
      { date: '2026-12-30', account: 'Expenses:Food', number: '30', currency: 'CNY' },
      { date: '2026-12-30', account: 'Assets:Bank:CNB', number: '-30', currency: 'CNY' },
      // 2027-01-02（周六）ISO 仍属 2026-W53
      { date: '2027-01-02', account: 'Expenses:Food', number: '20', currency: 'CNY' },
      { date: '2027-01-02', account: 'Assets:Bank:CNB', number: '-20', currency: 'CNY' },
      // 2027-01-04（周一）属 2027-W01
      { date: '2027-01-04', account: 'Assets:Bank:CNB', number: '500', currency: 'CNY' },
      { date: '2027-01-04', account: 'Income:Bonus', number: '-500', currency: 'CNY' }
    ]
    const pts = computeNetWorth(wk, 'week', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2026-W53', '2027-W01'])
    // 2026-W53 末：assets = 100 - 30 - 20 = 50（累计口径，不含 2027-W01）
    expect(pts[0]).toEqual({ period: '2026-W53', assets: '50', liabilities: '0', netWorth: '50' })
    // 2027-W01 末（含全历史）：assets = 50 + 500 = 550
    expect(pts[1]).toEqual({ period: '2027-W01', assets: '550', liabilities: '0', netWorth: '550' })
  })

  it('week + 起止年筛选：输出点按 ISO 周年过滤（2025-12-29 属 2026-W01，随 2026 年范围输出），累计含历史', () => {
    const wk: PostingRow[] = [
      // 2025-12-29（周一）ISO 属 2026-W01
      { date: '2025-12-29', account: 'Assets:Bank:CNB', number: '100', currency: 'CNY' },
      { date: '2025-12-29', account: 'Income:Salary', number: '-100', currency: 'CNY' },
      { date: '2026-01-05', account: 'Assets:Bank:CNB', number: '50', currency: 'CNY' },
      { date: '2026-01-05', account: 'Income:Bonus', number: '-50', currency: 'CNY' }
    ]
    const pts = computeNetWorth(wk, 'week', 'CNY', { startYear: 2026 })
    expect(pts.map((p) => p.period)).toEqual(['2026-W01', '2026-W02'])
    expect(pts[0]).toEqual({ period: '2026-W01', assets: '100', liabilities: '0', netWorth: '100' })
    expect(pts[1]).toEqual({ period: '2026-W02', assets: '150', liabilities: '0', netWorth: '150' })
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

describe('computeIncomeExpense（正显示 + 月视图补满 + 起止年范围）', () => {
  it('month + 2026 单年：12 个月全量，income = -ΣIncome:*，expense = ΣExpenses:*（索引行支出记正数，正显示）', () => {
    const pts = computeIncomeExpense(rows, 'month', 'CNY', { startYear: 2026, endYear: 2026 })
    expect(pts).toHaveLength(12)
    const jan = pts.find((p) => p.period === '2026-01')!
    expect(jan).toEqual({ period: '2026-01', income: '0', expense: '20' })
    const feb = pts.find((p) => p.period === '2026-02')!
    expect(feb).toEqual({ period: '2026-02', income: '0', expense: '0' }) // USD 收入被过滤
    expect(pts.every((p) => p.period.startsWith('2026-'))).toBe(true)
  })

  it('month + 跨年范围：自 startYear-01 起逐月补满至 endYear-12', () => {
    const pts = computeIncomeExpense(rows, 'month', 'CNY', { startYear: 2025, endYear: 2026 })
    expect(pts).toHaveLength(24)
    expect(pts[0].period).toBe('2025-01')
    expect(pts.at(-1)?.period).toBe('2026-12')
    const mar25 = pts.find((p) => p.period === '2025-03')!
    expect(mar25).toEqual({ period: '2025-03', income: '10000', expense: '35' })
    const jun25 = pts.find((p) => p.period === '2025-06')!
    expect(jun25).toEqual({ period: '2025-06', income: '0', expense: '5' })
    const jan26 = pts.find((p) => p.period === '2026-01')!
    expect(jan26).toEqual({ period: '2026-01', income: '0', expense: '20' })
  })

  it('year：全历史按年分组，income/expense 正显示', () => {
    const pts = computeIncomeExpense(rows, 'year', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025', '2026'])
    expect(pts[0]).toEqual({ period: '2025', income: '10000', expense: '40' })
    expect(pts[1]).toEqual({ period: '2026', income: '0', expense: '20' })
  })

  it('year + 范围：只输出范围内有数据的年份', () => {
    const pts = computeIncomeExpense(rows, 'year', 'CNY', { startYear: 2025, endYear: 2025 })
    expect(pts.map((p) => p.period)).toEqual(['2025'])
    expect(pts[0]).toEqual({ period: '2025', income: '10000', expense: '40' })
  })

  it('month 粒度缺省范围：直接 throw（函数级防御，handler 必解析）', () => {
    expect(() => computeIncomeExpense(rows, 'month', 'CNY')).toThrow('startYear')
  })
})

describe('computeIncomeExpense（日/周粒度）', () => {
  it('day：逐日分组 income/expense 正显示（全被币种过滤的日期不输出）', () => {
    const pts = computeIncomeExpense(rows, 'day', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025-03-01', '2025-03-05', '2025-06-10', '2026-01-05'])
    expect(pts[0]).toEqual({ period: '2025-03-01', income: '10000', expense: '0' })
    expect(pts[1]).toEqual({ period: '2025-03-05', income: '0', expense: '35' })
    expect(pts[2]).toEqual({ period: '2025-06-10', income: '0', expense: '5' })
    expect(pts[3]).toEqual({ period: '2026-01-05', income: '0', expense: '20' })
  })

  it('week：按 ISO 周分组，跨年周界归属 ISO 周年', () => {
    const wk: PostingRow[] = [
      { date: '2026-12-28', account: 'Income:Salary', number: '-100', currency: 'CNY' },
      { date: '2026-12-30', account: 'Expenses:Food', number: '30', currency: 'CNY' },
      { date: '2027-01-02', account: 'Expenses:Food', number: '20', currency: 'CNY' },
      { date: '2027-01-04', account: 'Income:Bonus', number: '-500', currency: 'CNY' }
    ]
    const pts = computeIncomeExpense(wk, 'week', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2026-W53', '2027-W01'])
    expect(pts[0]).toEqual({ period: '2026-W53', income: '100', expense: '50' })
    expect(pts[1]).toEqual({ period: '2027-W01', income: '500', expense: '0' })
  })
})

describe('computeTrialBalance（三栏：期初/发生/期末，每账户每币种一行，Income 正显示）', () => {
  const tbRows: PostingRow[] = [
    { date: '2025-03-01', account: 'Assets:Bank:CNB', number: '10000', currency: 'CNY' },
    { date: '2025-03-01', account: 'Income:Salary', number: '-10000', currency: 'CNY' },
    { date: '2025-06-10', account: 'Expenses:Food', number: '35', currency: 'CNY' },
    { date: '2025-06-10', account: 'Assets:Bank:CNB', number: '-35', currency: 'CNY' },
    { date: '2026-01-05', account: 'Expenses:Food', number: '20', currency: 'CNY' },
    { date: '2026-01-05', account: 'Liabilities:CreditCard', number: '-20', currency: 'CNY' },
    { date: '2026-02-01', account: 'Assets:Bank:USD', number: '100', currency: 'USD' },
    { date: '2026-02-01', account: 'Income:Salary', number: '-100', currency: 'USD' }
  ]

  it('跨区间：opening = dateFrom 前净额，period = 区间净发生额，closing = opening + period', () => {
    const rows = computeTrialBalance(tbRows, { dateFrom: '2026-01-01', dateTo: '2026-12-31' })
    const cnb = rows.find((r) => r.name === 'Assets:Bank:CNB' && r.opening.currency === 'CNY')!
    // 2025-03-01 +10000、2025-06-10 -35 → opening 9965；区间内无发生
    expect(cnb.opening).toEqual({ number: '9965', currency: 'CNY' })
    expect(cnb.period).toEqual({ number: '0', currency: 'CNY' })
    expect(cnb.closing).toEqual({ number: '9965', currency: 'CNY' })
    const food = rows.find((r) => r.name === 'Expenses:Food' && r.opening.currency === 'CNY')!
    expect(food.opening).toEqual({ number: '35', currency: 'CNY' })
    expect(food.period).toEqual({ number: '20', currency: 'CNY' })
    expect(food.closing).toEqual({ number: '55', currency: 'CNY' })
    const cc = rows.find((r) => r.name === 'Liabilities:CreditCard')!
    expect(cc.opening).toEqual({ number: '0', currency: 'CNY' })
    expect(cc.period).toEqual({ number: '-20', currency: 'CNY' })
    expect(cc.closing).toEqual({ number: '-20', currency: 'CNY' })
    // Income 正显示（与余额树同口径：Income 行取反聚合）
    const salary = rows.find((r) => r.name === 'Income:Salary' && r.opening.currency === 'CNY')!
    expect(salary.opening).toEqual({ number: '10000', currency: 'CNY' })
    expect(salary.period).toEqual({ number: '0', currency: 'CNY' })
    expect(salary.closing).toEqual({ number: '10000', currency: 'CNY' })
  })

  it('无 dateFrom：opening 全为 0，period = 全量净额（dateTo 封顶）', () => {
    const rows = computeTrialBalance(tbRows, { dateTo: '2026-12-31' })
    const cnb = rows.find((r) => r.name === 'Assets:Bank:CNB' && r.opening.currency === 'CNY')!
    expect(cnb.opening).toEqual({ number: '0', currency: 'CNY' })
    expect(cnb.period).toEqual({ number: '9965', currency: 'CNY' })
    expect(cnb.closing).toEqual({ number: '9965', currency: 'CNY' })
  })

  it('多币种：每账户每币种一行', () => {
    const rows = computeTrialBalance(tbRows)
    const salary = rows.filter((r) => r.name === 'Income:Salary')
    expect(salary).toHaveLength(2)
    expect(salary.find((r) => r.opening.currency === 'CNY')!.closing).toEqual({ number: '10000', currency: 'CNY' })
    expect(salary.find((r) => r.opening.currency === 'USD')!.closing).toEqual({ number: '100', currency: 'USD' })
    const assets = rows.filter((r) => r.name === 'Assets:Bank:CNB')
    expect(assets).toHaveLength(1)
    expect(assets[0].closing).toEqual({ number: '9965', currency: 'CNY' })
  })

  it('currency 过滤：仅输出该币种行', () => {
    const rows = computeTrialBalance(tbRows, { currency: 'USD' })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.opening.currency === 'USD')).toBe(true)
  })

  it('空输入 → 空数组', () => {
    expect(computeTrialBalance([])).toEqual([])
  })
})

describe('computeCashFlow（Assets 资金池口径：流入/流出/净额，池内互转不计）', () => {
  // 每笔分录配对两条 posting（entryId 分组）；池内互转、池外偿还、多笔收入/支出覆盖口径。
  const cfRows: CashFlowPostingRow[] = [
    // 1: 收入 → Assets（流入 10000）
    { entryId: 1, date: '2026-01-05', account: 'Assets:Bank:CNB', number: '10000', currency: 'CNY' },
    { entryId: 1, date: '2026-01-05', account: 'Income:Salary', number: '-10000', currency: 'CNY' },
    // 2: Assets → Expenses（流出 35）
    { entryId: 2, date: '2026-01-10', account: 'Expenses:Food', number: '35', currency: 'CNY' },
    { entryId: 2, date: '2026-01-10', account: 'Assets:Bank:CNB', number: '-35', currency: 'CNY' },
    // 3: Assets 内部互转（池内互转不计）
    { entryId: 3, date: '2026-01-15', account: 'Assets:Bank:CNB', number: '-500', currency: 'CNY' },
    { entryId: 3, date: '2026-01-15', account: 'Assets:Cash', number: '500', currency: 'CNY' },
    // 4: Liabilities 还款（Assets → 非 Assets，流出 20）
    { entryId: 4, date: '2026-02-01', account: 'Liabilities:CreditCard', number: '20', currency: 'CNY' },
    { entryId: 4, date: '2026-02-01', account: 'Assets:Bank:CNB', number: '-20', currency: 'CNY' },
    // 5: 另一笔收入（流入 200，同月聚合）
    { entryId: 5, date: '2026-01-20', account: 'Assets:Bank:CNB', number: '200', currency: 'CNY' },
    { entryId: 5, date: '2026-01-20', account: 'Income:Bonus', number: '-200', currency: 'CNY' },
    // 6: USD 收入（币种过滤场景）
    { entryId: 6, date: '2026-02-10', account: 'Assets:Bank:USD', number: '300', currency: 'USD' },
    { entryId: 6, date: '2026-02-10', account: 'Income:Salary', number: '-300', currency: 'USD' }
  ]

  it('month：inflow/outflow 正确、池内互转不计、net = inflow - outflow（最新期间在前）', () => {
    const pts = computeCashFlow(cfRows, { granularity: 'month' })
    // 最新期间在前（降序）：2026-02 先于 2026-01
    expect(pts.map((p) => p.period)).toEqual(['2026-02', '2026-01'])
    // 02：流入 300（USD 未过滤时计入）；流出 20
    expect(pts[0]).toEqual({ period: '2026-02', inflow: '300', outflow: '20', net: '280' })
    // 01：流入 10000 + 200 = 10200；流出 35（互转不计）；net = 10165
    expect(pts[1]).toEqual({ period: '2026-01', inflow: '10200', outflow: '35', net: '10165' })
  })

  it('currency 过滤：仅该币种参与流入/流出判定（最新期间在前）', () => {
    const pts = computeCashFlow(cfRows, { granularity: 'month', currency: 'CNY' })
    expect(pts.map((p) => p.period)).toEqual(['2026-02', '2026-01'])
    // 2026-02：USD 被过滤 → 流入 0，流出 20
    expect(pts[0]).toEqual({ period: '2026-02', inflow: '0', outflow: '20', net: '-20' })
  })

  it('day：逐日分组；week：ISO 周分组（最新期间在前）', () => {
    const dayPts = computeCashFlow(cfRows, { granularity: 'day', currency: 'CNY' })
    // 最新日期在前（降序）
    expect(dayPts.map((p) => p.period)).toEqual(['2026-02-01', '2026-01-20', '2026-01-10', '2026-01-05'])
    expect(dayPts[0]).toEqual({ period: '2026-02-01', inflow: '0', outflow: '20', net: '-20' })
    expect(dayPts[1]).toEqual({ period: '2026-01-20', inflow: '200', outflow: '0', net: '200' })
    // 2026-01-15 纯互转 → 无输出点
    expect(dayPts.find((p) => p.period === '2026-01-15')).toBeUndefined()
    expect(dayPts[2]).toEqual({ period: '2026-01-10', inflow: '0', outflow: '35', net: '-35' })
    expect(dayPts[3]).toEqual({ period: '2026-01-05', inflow: '10000', outflow: '0', net: '10000' })

    const weekPts = computeCashFlow(
      [
        { entryId: 1, date: '2026-12-29', account: 'Assets:Bank:CNB', number: '100', currency: 'CNY' },
        { entryId: 1, date: '2026-12-29', account: 'Income:Salary', number: '-100', currency: 'CNY' },
        { entryId: 2, date: '2027-01-04', account: 'Expenses:Food', number: '50', currency: 'CNY' },
        { entryId: 2, date: '2027-01-04', account: 'Assets:Bank:CNB', number: '-50', currency: 'CNY' }
      ],
      { granularity: 'week', currency: 'CNY' }
    )
    // 2026-12-29（周二）ISO 属 2026-W53；2027-01-04 属 2027-W01；最新周在前
    expect(weekPts.map((p) => p.period)).toEqual(['2027-W01', '2026-W53'])
    expect(weekPts[0]).toEqual({ period: '2027-W01', inflow: '0', outflow: '50', net: '-50' })
    expect(weekPts[1]).toEqual({ period: '2026-W53', inflow: '100', outflow: '0', net: '100' })
  })

  it('dateFrom/dateTo：仅区间内分录参与', () => {
    const pts = computeCashFlow(cfRows, { granularity: 'month', currency: 'CNY', dateFrom: '2026-01-01', dateTo: '2026-01-31' })
    expect(pts.map((p) => p.period)).toEqual(['2026-01'])
    expect(pts[0]).toEqual({ period: '2026-01', inflow: '10200', outflow: '35', net: '10165' })
  })

  it('空输入 → 空数组', () => {
    expect(computeCashFlow([], { granularity: 'month' })).toEqual([])
  })
})
