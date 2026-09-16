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
 *
 * 金额着色（2026-09-16）改按 `txKind`（主进程算好的交易类型）而非金额正负：借出是正数却既不是
 * 收入也不是普通转账，靠正负号无法着色。色调由 `TX_KIND_META` 映射，色值见 styles/tokens.less。
 */
import type { LedgerEntryRow, TxKind } from '../../../../shared/ipc'
import { formatAmount } from '../../utils/format'

/** 单元格文本：label 为显示文本（账户库中文名），raw 为原始账户路径串（Tooltip 展示） */
export interface AccountCell {
  label: string
  raw: string
}

/** 账户名解析器（账户库中文名；无映射回落路径本身） */
export type AccountNamer = (value: string) => string

/** 色调（色值见 styles/tokens.less 的 --bw-ink-*）：色编码**会计性质**，不是资金方向 */
export type TxTone = 'income' | 'expense' | 'lend' | 'neutral'

/** 交易类型的展示元数据：label = 金额前的文字标签（颜色之外的第二重标记，也是类型图例） */
export interface TxKindMeta {
  label: string
  tone: TxTone
  /** Tooltip：一句话口径说明 */
  hint: string
}

export const TX_KIND_META: Record<TxKind, TxKindMeta> = {
  income: { label: '收入', tone: 'income', hint: '收入类目入账，形成收益（资产流视角为正）' },
  expense: { label: '支出', tone: 'expense', hint: '支出类目出账，形成费用（资产流视角为负）' },
  lend: { label: '借出', tone: 'lend', hint: '资金转入往来类账户，形成对对方的应收——不是支出' },
  borrow: { label: '借入', tone: 'lend', hint: '资金从往来类负债账户流入，形成对对方的应付——不是收入' },
  recover: { label: '收回', tone: 'lend', hint: '对方还款，往来类账户的应收减少' },
  repay: { label: '还款', tone: 'lend', hint: '偿还往来类负债账户，应付减少' },
  transfer: { label: '转账', tone: 'neutral', hint: '账户间搬移，不产生损益、不改变债权债务' },
  equity: { label: '权益', tone: 'neutral', hint: '权益调整（含期初余额），不产生损益' }
}

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

/**
 * 金额列取值：损益金额（资产流视角，带正负）→ 搬移发生额（无正负）→ null（无金额可显示）。
 * `kind` 为 null 时（无金额条目、或外币交易在运营货币下无损益腿）调用方只渲染「—」，不打标签。
 */
export function amountDisplay(
  row: Pick<LedgerEntryRow, 'amount' | 'currency' | 'flowAmount' | 'txKind'>,
  opts: { withCurrency?: boolean } = {}
): { text: string; kind: TxKind | null } | null {
  const suffix = opts.withCurrency !== false && row.currency ? ` ${row.currency}` : ''
  if (row.amount !== null) return { text: `${formatAmount(row.amount)}${suffix}`, kind: row.txKind }
  if (row.flowAmount !== null) return { text: `${formatAmount(row.flowAmount)}${suffix}`, kind: row.txKind }
  return null
}
