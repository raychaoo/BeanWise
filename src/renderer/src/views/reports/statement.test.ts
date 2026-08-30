/**
 * statement.ts 纯函数单测（批次 E Task 3，TDD）：以 reports.beancount fixture 形状的
 * 余额树 / 收支序列为基准。金额一律十进制字符串（addDecimalStrings 族），禁 Number/parseFloat。
 */
import { describe, expect, it } from 'vitest'
import type { AccountBalance, IncomeExpensePoint } from '../../../../shared/ipc'
import {
  amountFor,
  buildBalanceSheetRows,
  buildIncomeStatementRows,
  displayPositive,
  flattenLeaves,
  identityDiff,
  netIncomeFromSeries,
  sumTotals
} from './statement'

/** buildAccountTree 产出形状（fixture：Assets:Bank:CNB 单叶子 rollup + 负债 -20） */
const TREE: AccountBalance[] = [
  {
    name: 'Assets',
    balances: [{ currency: 'CNY', number: '19960' }],
    children: [
      {
        name: 'Assets:Bank',
        balances: [{ currency: 'CNY', number: '19960' }],
        children: [{ name: 'Assets:Bank:CNB', balances: [{ currency: 'CNY', number: '19960' }] }]
      }
    ]
  },
  {
    name: 'Liabilities',
    balances: [{ currency: 'CNY', number: '-20' }],
    children: [{ name: 'Liabilities:CreditCard', balances: [{ currency: 'CNY', number: '-20' }] }]
  }
]

describe('flattenLeaves', () => {
  it('收集无 children 的叶子节点（中间 rollup 节点不作为报表行）', () => {
    expect(flattenLeaves(TREE[0]).map((n) => n.name)).toEqual(['Assets:Bank:CNB'])
  })
  it('叶子节点自身 → [自身]', () => {
    expect(flattenLeaves(TREE[0].children![0].children![0]).map((n) => n.name)).toEqual(['Assets:Bank:CNB'])
  })
  it('无子树（无 balances）→ 空数组', () => {
    expect(flattenLeaves({ name: 'Equity', balances: [] })).toEqual([])
  })
})

describe('amountFor', () => {
  it('取指定币种金额', () => {
    expect(amountFor(TREE[0], 'CNY')).toBe('19960')
  })
  it('缺失币种 → 0（报表按运营货币单币种列示）', () => {
    expect(amountFor(TREE[0], 'USD')).toBe('0')
  })
})

describe('sumTotals', () => {
  it('叶子合计走 addDecimalStrings 精确累加', () => {
    const leaves = [...flattenLeaves(TREE[0]), ...flattenLeaves(TREE[1])]
    expect(sumTotals(leaves, 'CNY')).toBe('19940')
  })
  it('空列表 → 0', () => {
    expect(sumTotals([], 'CNY')).toBe('0')
  })
})

describe('identityDiff', () => {
  it('资产 = 负债 + 权益（翻转后）→ 差额 0', () => {
    expect(identityDiff('19960', '19960')).toBe('0')
  })
  it('资产多出 → 正差额', () => {
    expect(identityDiff('19960', '19940')).toBe('20')
  })
  it('负债权益多于资产 → 负差额', () => {
    expect(identityDiff('100', '250')).toBe('-150')
  })
})

describe('netIncomeFromSeries', () => {
  it('逐年 Σ(收入 − 支出)：fixture 两点 → 19965', () => {
    const points: IncomeExpensePoint[] = [
      { period: '2025', income: '10000', expense: '40' },
      { period: '2026', income: '10000', expense: '20' }
    ]
    expect(netIncomeFromSeries(points)).toBe('19940')
  })
  it('支出大于收入 → 负净利润（赤字）', () => {
    expect(netIncomeFromSeries([{ period: '2026', income: '0', expense: '50' }])).toBe('-50')
  })
  it('空序列 → 0', () => {
    expect(netIncomeFromSeries([])).toBe('0')
  })
})

describe('displayPositive', () => {
  it('右栏（负债/权益）翻转存储符号为正显示', () => {
    expect(displayPositive('-20')).toBe('20')
    expect(displayPositive('30')).toBe('-30')
    expect(displayPositive('0')).toBe('0')
  })
})

describe('buildBalanceSheetRows', () => {
  it('fixture 形状：右栏负债翻转 20 + 未分配利润 19940 → 与资产 19960 平衡（diff 0）', () => {
    const r = buildBalanceSheetRows(TREE, 'CNY', '19940')
    expect(r.assetsTotal).toBe('19960')
    expect(r.rightTotal).toBe('19960')
    expect(r.diff).toBe('0')
    expect(r.left.map((x) => [x.label, x.amount, x.kind])).toEqual([
      ['Assets:Bank:CNB', '19960', 'item'],
      ['资产合计', '19960', 'total']
    ])
    expect(r.right.map((x) => [x.label, x.amount, x.kind])).toEqual([
      ['Liabilities:CreditCard', '20', 'item'],
      ['负债合计', '20', 'subtotal'],
      ['未分配利润（累计损益）', '19940', 'item'],
      ['负债和所有者权益合计', '19960', 'total']
    ])
  })
  it('无负债/权益节点：右栏仅未分配利润 + 合计行，diff = 资产 − 未分配利润', () => {
    const r = buildBalanceSheetRows([TREE[0]], 'CNY', '40')
    expect(r.rightTotal).toBe('40')
    expect(r.diff).toBe('19920')
    expect(r.right.map((x) => x.kind)).toEqual(['item', 'total'])
  })
  it('权益节点有叶子时输出权益合计小计行', () => {
    const equity: AccountBalance = {
      name: 'Equity',
      balances: [{ currency: 'CNY', number: '-100' }],
      children: [{ name: 'Equity:Opening', balances: [{ currency: 'CNY', number: '-100' }] }]
    }
    const r = buildBalanceSheetRows([equity], 'CNY', '0')
    expect(r.right.map((x) => [x.label, x.amount, x.kind])).toEqual([
      ['Equity:Opening', '100', 'item'],
      ['权益合计', '100', 'subtotal'],
      ['未分配利润（累计损益）', '0', 'item'],
      ['负债和所有者权益合计', '100', 'total']
    ])
  })
})

describe('buildIncomeStatementRows', () => {
  const incomeLeaves: AccountBalance[] = [{ name: 'Income:Salary', balances: [{ currency: 'CNY', number: '20000' }] }]
  const expenseLeaves: AccountBalance[] = [
    { name: 'Expenses:Food', balances: [{ currency: 'CNY', number: '55' }] },
    { name: 'Expenses:Transport', balances: [{ currency: 'CNY', number: '5' }] }
  ]

  it('本月汇总 + 累计明细行装配（报告式上下结构）', () => {
    const r = buildIncomeStatementRows(
      { period: '2025-03', income: '10000', expense: '35' },
      '2025年03月',
      incomeLeaves,
      expenseLeaves,
      'CNY',
      2025
    )
    expect(r.net).toBe('9965')
    expect(r.incomeSubtotal).toBe('20000')
    expect(r.expenseSubtotal).toBe('60')
    expect(r.cumulativeNet).toBe('19940')
    expect(r.rows.map((x) => [x.label, x.amount, x.kind])).toEqual([
      ['本月（2025年03月）', '', 'section'],
      ['收入', '10000', 'item'],
      ['支出', '35', 'item'],
      ['净利润（2025年03月）', '9965', 'net'],
      ['收入明细（截至 2025 年末累计）', '', 'section'],
      ['Income:Salary', '20000', 'item'],
      ['收入小计', '20000', 'subtotal'],
      ['支出明细（截至 2025 年末累计）', '', 'section'],
      ['Expenses:Food', '55', 'item'],
      ['Expenses:Transport', '5', 'item'],
      ['支出小计', '60', 'subtotal'],
      ['净利润（累计至 2025 年末）', '19940', 'net']
    ])
  })
  it('支出大于收入的月份 → 净利润为负（赤字，.num-negative 由组件按符号挂类）', () => {
    const r = buildIncomeStatementRows({ period: '2026-01', income: '0', expense: '50' }, '2026年01月', [], [], 'CNY', 2026)
    expect(r.net).toBe('-50')
    expect(r.rows.filter((x) => x.kind === 'section')).toHaveLength(1) // 无累计明细 → 仅本月一节
  })
})
