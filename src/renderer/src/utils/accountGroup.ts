/**
 * 账户下拉五大类分组（批次 B Task 2，方案模块 3）：按 value 首段（Assets|Liabilities|Equity|Income|Expenses）
 * 分组，组标签用中文；固定组序，未知首段归「其他」置底；组内保持原序；空组不输出
 * （antd Select 会渲染空组头）。
 */
import type { AccountOption } from '../stores/ledger'

export interface AccountOptionGroup {
  label: string
  options: AccountOption[]
}

const GROUP_ORDER: Array<{ prefix: string; label: string }> = [
  { prefix: 'Assets', label: '资产' },
  { prefix: 'Liabilities', label: '负债' },
  { prefix: 'Equity', label: '权益' },
  { prefix: 'Income', label: '收入' },
  { prefix: 'Expenses', label: '支出' }
]

export function groupAccountOptions(options: AccountOption[]): AccountOptionGroup[] {
  const known = new Map<string, AccountOption[]>()
  const other: AccountOption[] = []
  const prefixes = new Set(GROUP_ORDER.map((g) => g.prefix))
  for (const opt of options) {
    const root = opt.value.split(':')[0]
    if (prefixes.has(root)) {
      const list = known.get(root)
      if (list) list.push(opt)
      else known.set(root, [opt])
    } else {
      other.push(opt)
    }
  }
  const groups = GROUP_ORDER.map((g) => ({ label: g.label, options: known.get(g.prefix) ?? [] })).filter(
    (g) => g.options.length > 0
  )
  if (other.length > 0) groups.push({ label: '其他', options: other })
  return groups
}
