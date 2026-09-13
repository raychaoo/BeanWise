/**
 * 编辑/录入表单的账户下拉过滤。
 * 双行录入维持「两行不能同为收支账户」；多行分录只要求至少一行是资产/负债/权益，
 * 因此其它行已有资产负债表账户时，本行应允许选择另一个收支账户。
 */
import { accountType, BALANCE_SHEET_ACCOUNT_TYPES, filterAccountOptions, isPnlAccountType } from '../../../../shared/account'
import type { AccountOption } from '../../stores/ledger'
import type { PostingRow } from './entryFormValues'

export function filterEntryAccountOptions(
  options: readonly AccountOption[],
  rows: Array<PostingRow | undefined>,
  rowIndex: number
): AccountOption[] {
  const others = rows
    .map((row, index) => (index === rowIndex ? undefined : row?.account?.trim()))
    .filter((account): account is string => !!account)
  if (rows.length <= 2) return filterAccountOptions(options, others[0])

  const hasBalanceSheet = others.some((account) => {
    const type = accountType(account)
    return type !== undefined && BALANCE_SHEET_ACCOUNT_TYPES.includes(type)
  })
  if (hasBalanceSheet) return [...options]

  return options.filter((option) => {
    const type = accountType(option.value)
    return type === undefined || !isPnlAccountType(type)
  })
}
