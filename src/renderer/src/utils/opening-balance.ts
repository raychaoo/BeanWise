/**
 * 期初余额组合纯函数（批次 I）：账户页输入 金额/货币/日期 → 组合 AddEntryParams，
 * 经既有 ledger:add-entry 通道落账本（Equity:Opening-Balances 配对）。
 * 红线：期初余额不存配置文件、不引入第二写路径；金额全链路十进制字符串（禁 Number）。
 */
import { computeBalancingNumber } from '../../../shared/decimal'
import type { AddEntryParams } from '../../../shared/ipc'

/** 开账权益账户（Beancount 惯例）：与期初余额行配对，保证总账平衡 */
const OPENING_BALANCES_ACCOUNT = 'Equity:Opening-Balances'

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

export interface OpeningBalanceInput {
  /** Beancount 账户全路径（如 Assets:Bank:CNB） */
  account: string
  /** 十进制字符串金额（非负） */
  number: string
  currency: string
  /** YYYY-MM-DD */
  date: string
}

export function buildOpeningBalanceEntry(input: OpeningBalanceInput): AddEntryParams | { error: string } {
  const account = input.account.trim()
  const currency = input.currency.trim()
  const number = input.number.trim()

  if (!account) return { error: '账户不能为空' }
  // 账户非 PnL：期初余额只对资产/负债账户有意义（UI 仅对 Assets/Liabilities 行展示入口）
  const accountType = account.split(':')[0]
  if (accountType === 'Income' || accountType === 'Expenses') {
    return { error: '期初余额仅对资产/负债类账户有意义，收入/支出账户请直接记交易' }
  }
  if (!DECIMAL_RE.test(number)) return { error: `金额格式不合法：${number || '（空）'}` }
  if (number.startsWith('-')) return { error: '期初余额金额不能为负数' }
  if (!currency) return { error: '货币不能为空' }

  return {
    date: input.date,
    flag: '*',
    narration: '期初余额',
    postings: [
      { account, number, currency },
      { account: OPENING_BALANCES_ACCOUNT, number: computeBalancingNumber([number]), currency }
    ]
  }
}
