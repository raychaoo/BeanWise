/**
 * 平衡提示状态（批次 B Task 3 纯函数，方案模块 3）：复用 computeBalancingNumber（十进制字符串，
 * 禁浮点），异常（金额非法）走 'none' 交给表单校验提示，不在输入时抛错。
 * 末行空且前 n-1 行全有值 → 预告自动平衡值（与 EntryFormView 的 nextBalancingNumber 同语义）；
 * 全行有值 → 和为 0 平衡 / 否则差额；其余（无金额、部分输入）→ 'none' 不显示。
 */
import { computeBalancingNumber, negateDecimal } from '../../../../shared/decimal'
import { formatAmount } from '../../utils/format'

export type BalanceHintKind = 'balanced' | 'diff' | 'none'

export interface BalanceHintState {
  kind: BalanceHintKind
  text: string
}

const NONE: BalanceHintState = { kind: 'none', text: '' }

export function balanceHintState(
  rows: Array<{ number?: string | null } | undefined> | undefined
): BalanceHintState {
  if (!rows || rows.length < 2) return NONE
  const lastIdx = rows.length - 1
  const lastAmount = rows[lastIdx]?.number?.trim() ?? ''
  const headAmounts = rows.slice(0, lastIdx).map((r) => r?.number?.trim() ?? '')
  if (lastAmount === '') {
    if (headAmounts.some((v) => v === '')) return NONE
    try {
      const balancing = computeBalancingNumber(headAmounts)
      return { kind: 'diff', text: `将自动平衡为 ${formatAmount(balancing)}` }
    } catch {
      return NONE
    }
  }
  if (headAmounts.some((v) => v === '')) return NONE
  try {
    // computeBalancingNumber 返回「和取反」：为 0 即平衡，否则差额 = 再取反回原和
    const balancing = computeBalancingNumber([...headAmounts, lastAmount])
    if (balancing === '0') return { kind: 'balanced', text: '借贷已平衡' }
    return { kind: 'diff', text: `差额 ${formatAmount(negateDecimal(balancing))}` }
  } catch {
    return NONE
  }
}
