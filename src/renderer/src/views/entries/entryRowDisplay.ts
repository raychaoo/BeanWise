/**
 * 明细行「账户」「金额」两列的取值口径（纯函数，脱离 antd 便于单测）。
 *
 * 这两列原先各有一次静默的取值错误，故把口径收拢到此处并由单测锁住：
 * - 账户列读了 `entries.account`（schema 注明**仅 Open 条目**有值）→ 除 Open 外全部显示「—」；
 *   交易应当显示 `pnlAccount`（支出/收入类目），账内搬移显示资金流向串。
 * - 账内搬移（转账 / 信用卡还款 / 往来借出还款 / 权益调整）无损益腿，`amount` 按设计为 null
 *   却无兜底分支 → 金额列也是「—」；现改用 `flowAmount`（发生额）。
 *
 * 两列同口径：金额列显示哪个数，账户列就说明该数属于哪些账户——损益额 → 损益类目；
 * 搬移发生额 → 「流出 → 流入」双方账户（一笔搬移没有单一归属方）。
 */
import type { LedgerEntryRow } from '../../../../shared/ipc'
import { formatAmount } from '../../utils/format'

/** 单元格文本：label 为显示文本（账户库中文名），raw 为原始账户路径串（Tooltip 展示） */
export interface AccountCell {
  label: string
  raw: string
}

/** 账户名解析器（账户库中文名；无映射回落路径本身） */
export type AccountNamer = (value: string) => string

/** 账户列取值：① 支出/收入类目 ② 账内搬移「流出 → 流入」账户串 ③ Open 条目自身账户；皆无 → null */
export function accountDisplay(
  row: Pick<LedgerEntryRow, 'pnlAccount' | 'flowFrom' | 'flowTo' | 'account'>,
  nameOf: AccountNamer
): AccountCell | null {
  if (row.pnlAccount) return { label: nameOf(row.pnlAccount), raw: row.pnlAccount }
  if (row.flowFrom.length > 0 || row.flowTo.length > 0) {
    const chain = (paths: string[], map: AccountNamer): string => paths.map(map).join('、')
    const label = [chain(row.flowFrom, nameOf), chain(row.flowTo, nameOf)].filter(Boolean).join(' → ')
    const raw = [row.flowFrom.join('、'), row.flowTo.join('、')].filter(Boolean).join(' → ')
    return { label, raw }
  }
  if (row.account) return { label: nameOf(row.account), raw: row.account }
  return null
}

/** 金额列取值：损益金额（资产流视角，带正负）→ 搬移发生额（无正负）→ null（无金额可显示） */
export function amountDisplay(
  row: Pick<LedgerEntryRow, 'amount' | 'currency' | 'flowAmount'>
): { text: string; negative: boolean } | null {
  const suffix = row.currency ? ` ${row.currency}` : ''
  if (row.amount !== null) return { text: `${formatAmount(row.amount)}${suffix}`, negative: row.amount.startsWith('-') }
  if (row.flowAmount !== null) return { text: `${formatAmount(row.flowAmount)}${suffix}`, negative: false }
  return null
}
