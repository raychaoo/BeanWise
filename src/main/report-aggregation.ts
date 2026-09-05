/**
 * M8 报表聚合纯函数（T2）。数据源 = SQLite 索引行（SQL 只做行筛选/排序），
 * 金额累计一律 addDecimalStrings 精确字符串运算——SQLite SUM() 转 REAL 丢精度，禁用。
 * 口径：趋势图按运营货币过滤；余额树多币种分行 + 子树 rollup（余额树中 Income 账户同样正显示）；收支正显示（income=-ΣIncome:*）。
 */
import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek'
import { addDecimalStrings, negateDecimal } from '../shared/decimal'
import type { AccountBalance, CashFlowPoint, IncomeExpensePoint, NetWorthPoint, ReportBreakdownParams, ReportGranularity, ReportYearRange, TrialBalanceRow } from '../shared/ipc'

dayjs.extend(isoWeek)

/** 索引行快照（ipc-handlers-report 查询产出）；entryId 为所属分录 id（现金流量表按分录配对用） */
export interface PostingRow {
  entryId?: number
  date: string // YYYY-MM-DD
  account: string
  number: string // 十进制字符串
  currency: string
}

/** 现金流量表输入行：PostingRow + 必带 entryId（loadRows 恒产出，跨分录判定流入/流出必需） */
export interface CashFlowPostingRow extends PostingRow {
  entryId: number
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

/**
 * 现金流量表（批次 G #7）。口径（与 UI 说明一致）：现金池 = `Assets:` 顶层组全部账户
 * （个人记账语境的资金池假设；后续如需精确圈定现金账户再立需求）。
 * 按分录（entryId）配对：池内互转（分录全为 Assets）不计；涉及池外的分录按池净变化判定——
 * assetsDelta > 0 → 流入（收入/对方转入），< 0 → 流出（支出/还款），= 0 → 不计；
 * net = inflow - outflow（addDecimalStrings + negateDecimal，字符串精确运算）。
 * 期间按 periodKey 分组；currency 缺省不按币种过滤（handler 一律传运营货币，多币种不混计）。
 */
export function computeCashFlow(
  rows: CashFlowPostingRow[],
  opts: { granularity: ReportGranularity; currency?: string; dateFrom?: string; dateTo?: string }
): CashFlowPoint[] {
  const groups = new Map<number, CashFlowPostingRow[]>()
  for (const r of rows) {
    if (opts.currency !== undefined && r.currency !== opts.currency) continue
    if (opts.dateFrom !== undefined && r.date < opts.dateFrom) continue
    if (opts.dateTo !== undefined && r.date > opts.dateTo) continue
    const list = groups.get(r.entryId)
    if (list) list.push(r)
    else groups.set(r.entryId, [r])
  }
  const inflow = new Map<string, string>()
  const outflow = new Map<string, string>()
  for (const group of groups.values()) {
    const assetsDelta = group
      .filter((r) => r.account.startsWith('Assets:'))
      .reduce((acc, r) => addDecimalStrings(acc, r.number), '0')
    const hasExternal = group.some((r) => !r.account.startsWith('Assets:'))
    if (assetsDelta === '0' || !hasExternal) continue // 池内互转（含仅 Assets 的分录）不计
    const period = periodKey(group[0].date, opts.granularity)
    if (assetsDelta.startsWith('-')) {
      const amount = negateDecimal(assetsDelta)
      outflow.set(period, addDecimalStrings(outflow.get(period) ?? '0', amount))
    } else {
      inflow.set(period, addDecimalStrings(inflow.get(period) ?? '0', assetsDelta))
    }
  }
  // 最新期间在前（降序），便于报表首行展示最近一期
  const periods = [...new Set([...inflow.keys(), ...outflow.keys()])].sort((a, b) => b.localeCompare(a))
  return periods.map((period) => {
    const inAmt = inflow.get(period) ?? '0'
    const outAmt = outflow.get(period) ?? '0'
    return { period, inflow: inAmt, outflow: outAmt, net: addDecimalStrings(inAmt, negateDecimal(outAmt)) }
  })
}

/**
 * 支出/收入类别汇总（breakdown，总览页「去向/来源」卡片）。
 * 顶层段聚合：取账户路径首两段（如 Expenses:Food:Snack → Expenses:Food），
 * 顶层段必须与 flow 前缀一致（expense→Expenses: / income→Income:），其余跳过。
 * 金额：expense 直接累加（索引行支出为正），income 取反累加（收入正显示）。
 * 输出按金额降序；超出 top 位的类别合并为末位「其他」。
 * ratio = amount / total（十进制字符串除法，保留 4 位小数；total 为 0 → ratio '0'）。
 */

/** 顶层段聚合键：首两段（Expenses:Food:Snack → Expenses:Food） */
function categoryKey(account: string): string {
  const parts = account.split(':')
  return parts.slice(0, 2).join(':')
}

// --- 十进制字符串除法（纯字符串运算，禁浮点；仅用于 breakdown 比例计算）

/** 非负整数串比较：> 0 / < 0 / === 0（等长比字典序；长度差即值差） */
function cmpMag(a: string, b: string): number {
  if (a.length !== b.length) return a.length > b.length ? 1 : -1
  return a === b ? 0 : a > b ? 1 : -1
}

/** 非负整数串减法：a - b（要求 a >= b）；结果无前导零 */
function subMag(a: string, b: string): string {
  let borrow = 0
  let out = ''
  let i = a.length - 1
  let j = b.length - 1
  for (; i >= 0; i--, j--) {
    let digit = (a.charCodeAt(i) - 48) - (j >= 0 ? b.charCodeAt(j) - 48 : 0) - borrow
    if (digit < 0) {
      digit += 10
      borrow = 1
    } else {
      borrow = 0
    }
    out = String(digit) + out
  }
  const trimmed = out.replace(/^0+(?=\d)/, '')
  return trimmed || '0'
}

/** 非负整数串 × 个位数（0~9） */
function mulDigit(a: string, n: number): string {
  if (n === 0) return '0'
  let carry = 0
  let out = ''
  for (let i = a.length - 1; i >= 0; i--) {
    const prod = (a.charCodeAt(i) - 48) * n + carry
    out = String(prod % 10) + out
    carry = Math.floor(prod / 10)
  }
  if (carry) out = String(carry) + out
  return out
}

/** 非负整数串除法：a / b → 向下取整的商（a, b 无前导零；b > 0） */
function divMag(a: string, b: string): string {
  if (cmpMag(a, b) < 0) return '0'
  let q = ''
  let rem = ''
  for (let i = 0; i < a.length; i++) {
    rem += a[i]
    const remNorm = rem.replace(/^0+(?=\d)/, '') || '0'
    let digit = 0
    while (cmpMag(remNorm, mulDigit(b, digit + 1)) >= 0) digit++
    q += String(digit)
    rem = subMag(remNorm, mulDigit(b, digit))
  }
  return q.replace(/^0+(?=\d)/, '') || '0'
}

/** 十进制字符串除法（a / b），保留 scale 位小数（放大后整除的截断近似）；b 为 0 → '0'。 */
function divDecimalStrings(a: string, b: string, scale = 4): string {
  if (b === '0') return '0'
  const aMag = a.startsWith('-') ? a.slice(1) : a
  const bMag = b.startsWith('-') ? b.slice(1) : b
  if (cmpMag(aMag, bMag) === 0) return '1'
  const q = divMag(aMag + '0'.repeat(scale), bMag)
  if (q === '0') return '0'
  if (q.length <= scale) return '0.' + q.padStart(scale, '0')
  return q.slice(0, q.length - scale) + '.' + q.slice(q.length - scale)
}

export function computeBreakdown(
  rows: PostingRow[],
  opts: { flow: 'expense' | 'income'; currency?: string; dateFrom?: string; dateTo?: string; top?: number }
): import('../shared/ipc').ReportBreakdownResult {
  const prefix = opts.flow === 'expense' ? 'Expenses:' : 'Income:'
  const sums = new Map<string, string>()
  let total = '0'
  for (const r of rows) {
    if (!r.account.startsWith(prefix)) continue
    if (opts.currency !== undefined && r.currency !== opts.currency) continue
    if (opts.dateFrom !== undefined && r.date < opts.dateFrom) continue
    if (opts.dateTo !== undefined && r.date > opts.dateTo) continue
    const key = categoryKey(r.account)
    const delta = opts.flow === 'income' ? negateDecimal(r.number) : r.number
    sums.set(key, addDecimalStrings(sums.get(key) ?? '0', delta))
    total = addDecimalStrings(total, delta)
  }
  // 按金额降序（breakdown 金额均为非负；同值按类别名升序稳定）
  const sorted = [...sums.entries()].sort((a, b) => {
    const cmp = cmpMag(b[1], a[1])
    return cmp !== 0 ? cmp : a[0].localeCompare(b[0])
  })
  const top = opts.top ?? 6
  const head = sorted.slice(0, top)
  const rest = sorted.slice(top)
  const items: import('../shared/ipc').ReportBreakdownResult['items'][number][] = head.map(([category, amount]) => ({
    category,
    amount,
    ratio: total === '0' ? '0' : divDecimalStrings(amount, total, 4)
  }))
  if (rest.length > 0) {
    const otherAmount = rest.reduce((acc, [, n]) => addDecimalStrings(acc, n), '0')
    items.push({
      category: '其他',
      amount: otherAmount,
      ratio: total === '0' ? '0' : divDecimalStrings(otherAmount, total, 4)
    })
  }
  return { items, total, currency: opts.currency ?? '' }
}
