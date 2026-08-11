/**
 * M8 报表聚合纯函数（T2）。数据源 = SQLite 索引行（SQL 只做行筛选/排序），
 * 金额累计一律 addDecimalStrings 精确字符串运算——SQLite SUM() 转 REAL 丢精度，禁用。
 * 口径：趋势图按运营货币过滤；余额树多币种分行 + 子树 rollup；收支正显示（income=-ΣIncome:*）。
 */
import { addDecimalStrings, negateDecimal } from '../shared/decimal'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint } from '../shared/ipc'

/** 索引行快照（ipc-handlers-report 查询产出） */
export interface PostingRow {
  date: string // YYYY-MM-DD
  account: string
  number: string // 十进制字符串
  currency: string
}

/** 期间桶：month → 'YYYY-MM'，year → 'YYYY' */
export function periodOf(date: string, granularity: 'month' | 'year'): string {
  return granularity === 'year' ? date.slice(0, 4) : date.slice(0, 7)
}

/**
 * 净资产趋势：按期间累计 assets/liabilities（行须按日期升序），netWorth = assets + liabilities
 * （Beancount 负债为负）。非运营货币行在分桶后累加时跳过——期间存在但全部行被币种过滤时，
 * 该期间仍输出与上期持平的未变点（2026-08-11 用户裁决，先分桶再按币种累加）。
 */
export function computeNetWorth(
  rows: PostingRow[],
  granularity: 'month' | 'year',
  currency: string
): NetWorthPoint[] {
  const buckets = new Map<string, { assets: string; liabilities: string }>()
  for (const r of rows) {
    const period = periodOf(r.date, granularity)
    const b = buckets.get(period) ?? { assets: '0', liabilities: '0' }
    if (r.currency === currency) {
      if (r.account.startsWith('Assets:')) b.assets = addDecimalStrings(b.assets, r.number)
      else if (r.account.startsWith('Liabilities:')) b.liabilities = addDecimalStrings(b.liabilities, r.number)
    }
    buckets.set(period, b)
  }
  const points: NetWorthPoint[] = []
  let assets = '0'
  let liabilities = '0'
  for (const period of [...buckets.keys()].sort()) {
    const b = buckets.get(period)!
    assets = addDecimalStrings(assets, b.assets)
    liabilities = addDecimalStrings(liabilities, b.liabilities)
    points.push({ period, assets, liabilities, netWorth: addDecimalStrings(assets, liabilities) })
  }
  return points
}

/**
 * 账户余额树：叶子余额按 (账户, 币种) 聚合 → 按 '.' 前缀建树，
 * 每个节点 balances = 子树各币种合计（递归 rollup），children 按名称字典序。
 */
export function buildAccountTree(rows: PostingRow[]): AccountBalance[] {
  const sums = new Map<string, Map<string, string>>() // account → currency → number
  for (const r of rows) {
    let m = sums.get(r.account)
    if (!m) {
      m = new Map()
      sums.set(r.account, m)
    }
    m.set(r.currency, addDecimalStrings(m.get(r.currency) ?? '0', r.number))
  }
  const nodes = new Map<string, AccountBalance>()
  const roots: AccountBalance[] = []
  for (const [account, byCurrency] of [...sums.entries()].sort()) {
    let parent: AccountBalance | undefined
    let path = ''
    for (const part of account.split(':')) {
      path = path ? `${path}:${part}` : part
      let node = nodes.get(path)
      if (!node) {
        // children 惰性创建：叶子节点保持无 children（AccountBalance.children 可选），
        // 与 rollup/sortRec 的 `?? []` / `?.` 处理一致（2026-08-11 TDD 修正，简报 Step 3 恒建空数组）
        node = { name: path, balances: [] }
        nodes.set(path, node)
        if (parent) {
          parent.children ??= []
          parent.children.push(node)
        } else roots.push(node)
      }
      parent = node
    }
    parent!.balances = [...byCurrency.entries()].map(([currency, number]) => ({ currency, number }))
  }
  function rollup(node: AccountBalance): Map<string, string> {
    const agg = new Map(node.balances.map((b) => [b.currency, b.number] as const))
    for (const child of node.children ?? []) {
      for (const [cur, num] of rollup(child)) agg.set(cur, addDecimalStrings(agg.get(cur) ?? '0', num))
    }
    node.balances = [...agg.entries()].map(([currency, number]) => ({ currency, number }))
    return agg
  }
  const sortRec = (n: AccountBalance): void => {
    n.children?.sort((a, b) => a.name.localeCompare(b.name))
    n.children?.forEach(sortRec)
  }
  for (const node of roots) rollup(node)
  roots.forEach(sortRec)
  return roots.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 收支对比：income = -ΣIncome:*（正显示），expense = ΣExpenses:*（正显示——索引行支出为正，
 * 见 brief 测试数据与 ai-entry-panel 惯例；2026-08-11 TDD 修正，简报 Step 3 的 expense 取反会显示负值）。
 * month 粒度 year 必传（handler 缺省解析最近年份；缺省直接 throw 函数级防御），补满 12 个月（无数据月为 0）；
 * year 粒度按全历史年份分组。
 */
export function computeIncomeExpense(
  rows: PostingRow[],
  granularity: 'month' | 'year',
  currency: string,
  year?: number
): IncomeExpensePoint[] {
  const incomeMap = new Map<string, string>()
  const expenseMap = new Map<string, string>()
  for (const r of rows) {
    if (r.currency !== currency) continue
    if (year !== undefined && r.date.slice(0, 4) !== String(year)) continue
    const period = periodOf(r.date, granularity)
    if (r.account.startsWith('Income:')) incomeMap.set(period, addDecimalStrings(incomeMap.get(period) ?? '0', r.number))
    else if (r.account.startsWith('Expenses:')) expenseMap.set(period, addDecimalStrings(expenseMap.get(period) ?? '0', r.number))
  }
  if (granularity === 'month') {
    if (year === undefined) throw new Error('computeIncomeExpense: month 粒度必须传 year（handler 必解析，函数级防御）')
    const points: IncomeExpensePoint[] = []
    for (let m = 1; m <= 12; m++) {
      const period = `${year}-${String(m).padStart(2, '0')}`
      points.push({
        period,
        income: negateDecimal(incomeMap.get(period) ?? '0'),
        expense: expenseMap.get(period) ?? '0'
      })
    }
    return points
  }
  const periods = [...new Set([...incomeMap.keys(), ...expenseMap.keys()])].sort()
  return periods.map((period) => ({
    period,
    income: negateDecimal(incomeMap.get(period) ?? '0'),
    expense: expenseMap.get(period) ?? '0'
  }))
}
