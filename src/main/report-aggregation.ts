/**
 * M8 报表聚合纯函数（T2）。数据源 = SQLite 索引行（SQL 只做行筛选/排序），
 * 金额累计一律 addDecimalStrings 精确字符串运算——SQLite SUM() 转 REAL 丢精度，禁用。
 * 口径：趋势图按运营货币过滤；余额树多币种分行 + 子树 rollup（余额树中 Income 账户同样正显示）；收支正显示（income=-ΣIncome:*）。
 */
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek'
import { addDecimalStrings, negateDecimal } from '../shared/decimal'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint, ReportGranularity, ReportYearRange, TrialBalanceRow } from '../shared/ipc'

dayjs.extend(isoWeek)

/** 索引行快照（ipc-handlers-report 查询产出） */
export interface PostingRow {
  date: string // YYYY-MM-DD
  account: string
  number: string // 十进制字符串
  currency: string
}

/**
 * 期间桶：day → 日期原值；week → ISO 周标签 `YYYY-Www`（周一起始，跨年周界按 ISO 周年归属，
 * 如 2027-01-01 属 2026-W53——用 dayjs isoWeek 插件，主进程/单测同为 node 环境可用）；
 * month → 'YYYY-MM'；year → 'YYYY'。
 */
export function periodKey(date: string, granularity: ReportGranularity): string {
  switch (granularity) {
    case 'day':
      return date
    case 'week': {
      const d = dayjs(date)
      return `${d.isoWeekYear()}-W${String(d.isoWeek()).padStart(2, '0')}`
    }
    case 'year':
      return date.slice(0, 4)
    default:
      return date.slice(0, 7)
  }
}

/** 期间是否落在年份范围内（period 前 4 位即年份，month/year 粒度通用）；无范围 → 恒 true */
function inYearRange(period: string, range?: ReportYearRange): boolean {
  if (!range) return true
  const year = Number(period.slice(0, 4))
  return (
    (range.startYear === undefined || year >= range.startYear) &&
    (range.endYear === undefined || year <= range.endYear)
  )
}

/**
 * 净资产趋势：按期间累计 assets/liabilities（行须按日期升序），netWorth = assets + liabilities
 * （Beancount 负债为负）。非运营货币行在分桶后累加时跳过——期间存在但全部行被币种过滤时，
 * 该期间仍输出与上期持平的未变点（2026-08-11 用户裁决，先分桶再按币种累加）。
 * range：仅对「输出点」按年份过滤，累计始终含全历史——趋势图中每点 = 截至该期间的期末净资产，
 * 起始年前的历史余额不会丢失（2026-08-23 起止年筛选）。
 */
export function computeNetWorth(
  rows: PostingRow[],
  granularity: ReportGranularity,
  currency: string,
  range?: ReportYearRange
): NetWorthPoint[] {
  const buckets = new Map<string, { assets: string; liabilities: string }>()
  for (const r of rows) {
    const period = periodKey(r.date, granularity)
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
    if (!inYearRange(period, range)) continue
    points.push({ period, assets, liabilities, netWorth: addDecimalStrings(assets, liabilities) })
  }
  return points
}

/**
 * 账户余额树：叶子余额按 (账户, 币种) 聚合 → 按 '.' 前缀建树，
 * 每个节点 balances = 子树各币种合计（递归 rollup），children 按名称字典序；
 * Income 账户按取反值聚合，余额表中收入显示为正，避免「工资收入 -100」。
 */
export function buildAccountTree(rows: PostingRow[]): AccountBalance[] {
  const sums = new Map<string, Map<string, string>>() // account → currency → number
  for (const r of rows) {
    let m = sums.get(r.account)
    if (!m) {
      m = new Map()
      sums.set(r.account, m)
    }
    const delta = r.account.startsWith('Income:') ? negateDecimal(r.number) : r.number
    m.set(r.currency, addDecimalStrings(m.get(r.currency) ?? '0', delta))
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
 * range：行先按年份过滤（在范围内才累计）；month 粒度 startYear/endYear 必传（handler 缺省解析；
 * 缺省直接 throw 函数级防御），自 startYear-01 起逐月补满至 endYear-12（无数据月为 0）；
 * year 粒度按范围内有数据的年份分组。
 */
export function computeIncomeExpense(
  rows: PostingRow[],
  granularity: ReportGranularity,
  currency: string,
  range?: ReportYearRange
): IncomeExpensePoint[] {
  const incomeMap = new Map<string, string>()
  const expenseMap = new Map<string, string>()
  for (const r of rows) {
    if (r.currency !== currency) continue
    const year = Number(r.date.slice(0, 4))
    if (range?.startYear !== undefined && year < range.startYear) continue
    if (range?.endYear !== undefined && year > range.endYear) continue
    const period = periodKey(r.date, granularity)
    if (r.account.startsWith('Income:')) incomeMap.set(period, addDecimalStrings(incomeMap.get(period) ?? '0', r.number))
    else if (r.account.startsWith('Expenses:')) expenseMap.set(period, addDecimalStrings(expenseMap.get(period) ?? '0', r.number))
  }
  if (granularity === 'month') {
    const start = range?.startYear
    const end = range?.endYear
    if (start === undefined || end === undefined) {
      throw new Error('computeIncomeExpense: month 粒度必须传 startYear/endYear（handler 必解析，函数级防御）')
    }
    const points: IncomeExpensePoint[] = []
    for (let y = start; y <= end; y++) {
      for (let m = 1; m <= 12; m++) {
        const period = `${y}-${String(m).padStart(2, '0')}`
        points.push({
          period,
          income: negateDecimal(incomeMap.get(period) ?? '0'),
          expense: expenseMap.get(period) ?? '0'
        })
      }
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

/**
 * 三栏式科目余额表：每账户每币种一行。opening = dateFrom 之前（不含）该账户累计净额；
 * period = [dateFrom, dateTo] 区间净发生额；closing = opening + period（addDecimalStrings）。
 * 无 dateFrom → opening = 0；无 dateTo → 至最新。Income 账户取反聚合（与 buildAccountTree 同口径：
 * 收入正显示，便于与报表页净资产勾稽）。currency 缺省 = 全部币种分行。行须按日期升序（handler 排序）。
 */
export function computeTrialBalance(
  rows: PostingRow[],
  opts: { dateFrom?: string; dateTo?: string; currency?: string } = {}
): TrialBalanceRow[] {
  const sums = new Map<string, Map<string, { opening: string; period: string }>>()
  for (const r of rows) {
    if (opts.currency !== undefined && r.currency !== opts.currency) continue
    if (opts.dateTo !== undefined && r.date > opts.dateTo) continue
    const delta = r.account.startsWith('Income:') ? negateDecimal(r.number) : r.number
    let byCurrency = sums.get(r.account)
    if (!byCurrency) {
      byCurrency = new Map()
      sums.set(r.account, byCurrency)
    }
    let cell = byCurrency.get(r.currency)
    if (!cell) {
      cell = { opening: '0', period: '0' }
      byCurrency.set(r.currency, cell)
    }
    if (opts.dateFrom !== undefined && r.date < opts.dateFrom) {
      cell.opening = addDecimalStrings(cell.opening, delta)
    } else {
      cell.period = addDecimalStrings(cell.period, delta)
    }
    byCurrency.set(r.currency, cell)
  }
  const out: TrialBalanceRow[] = []
  for (const [account, byCurrency] of [...sums.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const [currency, cell] of [...byCurrency.entries()].sort()) {
      out.push({
        name: account,
        opening: { number: cell.opening, currency },
        period: { number: cell.period, currency },
        closing: { number: addDecimalStrings(cell.opening, cell.period), currency }
      })
    }
  }
  return out
}
