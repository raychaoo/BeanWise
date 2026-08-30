/**
 * 报表三表纯函数（批次 E Task 3）：资产负债表 / 利润表的聚合与校验逻辑，
 * 与组件解耦便于 Vitest 覆盖。金额一律十进制字符串（decimal.ts 精确运算，
 * 禁 Number/parseFloat）；报表按运营货币单币种列示（正式报表口径，多币种
 * 全貌见「趋势图表」Tab 的账户余额表）。
 */
import { addDecimalStrings, computeBalancingNumber, negateDecimal } from '../../../../shared/decimal'
import type { AccountBalance, IncomeExpensePoint } from '../../../../shared/ipc'

/** 深度收集叶子节点（无 children）——资产负债表/利润表「逐账户」行；中间 rollup 节点不作为行 */
export function flattenLeaves(node: AccountBalance): AccountBalance[] {
  if (!node.children || node.children.length === 0) return node.balances.length > 0 ? [node] : []
  return node.children.flatMap(flattenLeaves)
}

/** 取节点指定币种金额；缺失币种 → '0'（单币种报表口径下该账户本币计价为零） */
export function amountFor(node: AccountBalance, currency: string): string {
  return node.balances.find((b) => b.currency === currency)?.number ?? '0'
}

/** 一组节点的指定币种合计（addDecimalStrings 精确累加） */
export function sumTotals(nodes: AccountBalance[], currency: string): string {
  return nodes.reduce((acc, n) => addDecimalStrings(acc, amountFor(n, currency)), '0')
}

/**
 * 会计恒等式差额：资产合计 − 负债权益合计（负债/权益已翻转正显示后的右栏合计）。
 * computeBalancingNumber([-资产, 右栏合计]) = 资产 − 右栏合计；'0' 即平衡。
 */
export function identityDiff(assetsTotal: string, rightTotal: string): string {
  return computeBalancingNumber([negateDecimal(assetsTotal), rightTotal])
}

/** 累计净利润 = Σ 各期（收入 − 支出）（收支序列均为正显示） */
export function netIncomeFromSeries(points: IncomeExpensePoint[]): string {
  return points.reduce((acc, p) => addDecimalStrings(acc, addDecimalStrings(p.income, negateDecimal(p.expense))), '0')
}

/** 右栏（负债/权益）行正显示：翻转 Beancount 存储符号（负债/权益为负，报表列正数） */
export function displayPositive(stored: string): string {
  return negateDecimal(stored)
}

/** 报表行类别：section 小节标题 / item 明细 / subtotal 小计 / total 合计 / net 净利润（强调） */
export type StatementRowKind = 'section' | 'item' | 'subtotal' | 'total' | 'net'

export interface StatementRow {
  key: string
  label: string
  /** 十进制字符串（section 行为 ''，金额列以 colSpan 合并展示标题） */
  amount: string
  kind: StatementRowKind
}

function row(kind: StatementRowKind, key: string, label: string, amount: string): StatementRow {
  return { kind, key, label, amount }
}

/**
 * 资产负债表两栏行装配（账户式）：左栏 = Assets 叶子 + 资产合计；右栏 = 负债叶子 + 负债小计 +
 * 权益叶子 + 权益小计 + 未分配利润（累计损益，使未结转损益的账本亦满足恒等式）+ 右栏合计。
 * 负债/权益行以 displayPositive 翻转正显示；右栏合计 = 负债 + 权益 + 未分配利润（翻转后口径）。
 */
export function buildBalanceSheetRows(
  accounts: AccountBalance[],
  currency: string,
  retainedEarnings: string
): { left: StatementRow[]; right: StatementRow[]; assetsTotal: string; rightTotal: string; diff: string } {
  const root = (name: string): AccountBalance | undefined => accounts.find((n) => n.name === name)

  const assetLeaves = root('Assets') ? flattenLeaves(root('Assets')!) : []
  const liabilityLeaves = root('Liabilities') ? flattenLeaves(root('Liabilities')!) : []
  const equityLeaves = root('Equity') ? flattenLeaves(root('Equity')!) : []

  const assetsTotal = sumTotals(assetLeaves, currency)
  const liabilityTotal = sumTotals(liabilityLeaves, currency)
  const equityTotal = sumTotals(equityLeaves, currency)

  const left: StatementRow[] = assetLeaves.map((n, i) => row('item', `a${i}`, n.name, amountFor(n, currency)))
  left.push(row('total', 'assets-total', '资产合计', assetsTotal))

  const right: StatementRow[] = liabilityLeaves.map((n, i) =>
    row('item', `l${i}`, n.name, displayPositive(amountFor(n, currency)))
  )
  if (liabilityLeaves.length > 0) right.push(row('subtotal', 'liab-subtotal', '负债合计', displayPositive(liabilityTotal)))
  right.push(...equityLeaves.map((n, i) => row('item', `e${i}`, n.name, displayPositive(amountFor(n, currency)))))
  if (equityLeaves.length > 0) right.push(row('subtotal', 'equity-subtotal', '权益合计', displayPositive(equityTotal)))
  right.push(row('item', 'retained', '未分配利润（累计损益）', retainedEarnings))
  const rightTotal = addDecimalStrings(addDecimalStrings(displayPositive(liabilityTotal), displayPositive(equityTotal)), retainedEarnings)
  right.push(row('total', 'right-total', '负债和所有者权益合计', rightTotal))

  return { left, right, assetsTotal, rightTotal, diff: identityDiff(assetsTotal, rightTotal) }
}

/**
 * 利润表行装配（报告式上下结构）：本月（YYYY年MM）汇总 → 累计明细（收入叶子 → 小计 →
 * 支出叶子 → 小计）→ 净利润（累计）强调行。收支叶子均正显示（余额树 Income 已取反、
 * Expenses 索引行为正）；无累计叶子时省略明细节。
 */
export function buildIncomeStatementRows(
  monthPoint: IncomeExpensePoint | null,
  monthLabel: string,
  incomeLeaves: AccountBalance[],
  expenseLeaves: AccountBalance[],
  currency: string,
  cumulativeYear: number
): {
  rows: StatementRow[]
  net: string
  incomeSubtotal: string
  expenseSubtotal: string
  cumulativeNet: string
} {
  const income = monthPoint?.income ?? '0'
  const expense = monthPoint?.expense ?? '0'
  const net = addDecimalStrings(income, negateDecimal(expense))

  const incomeSubtotal = sumTotals(incomeLeaves, currency)
  const expenseSubtotal = sumTotals(expenseLeaves, currency)
  const cumulativeNet = addDecimalStrings(incomeSubtotal, negateDecimal(expenseSubtotal))

  const rows: StatementRow[] = [
    row('section', 'month-section', `本月（${monthLabel}）`, ''),
    row('item', 'month-income', '收入', income),
    row('item', 'month-expense', '支出', expense),
    row('net', 'month-net', `净利润（${monthLabel}）`, net)
  ]
  if (incomeLeaves.length > 0) {
    rows.push(row('section', 'income-section', `收入明细（截至 ${cumulativeYear} 年末累计）`, ''))
    rows.push(...incomeLeaves.map((n, i) => row('item', `i${i}`, n.name, amountFor(n, currency))))
    rows.push(row('subtotal', 'income-subtotal', '收入小计', incomeSubtotal))
  }
  if (expenseLeaves.length > 0) {
    rows.push(row('section', 'expense-section', `支出明细（截至 ${cumulativeYear} 年末累计）`, ''))
    rows.push(...expenseLeaves.map((n, i) => row('item', `x${i}`, n.name, amountFor(n, currency))))
    rows.push(row('subtotal', 'expense-subtotal', '支出小计', expenseSubtotal))
  }
  rows.push(row('net', 'cumulative-net', `净利润（累计至 ${cumulativeYear} 年末）`, cumulativeNet))

  return { rows, net, incomeSubtotal, expenseSubtotal, cumulativeNet }
}
