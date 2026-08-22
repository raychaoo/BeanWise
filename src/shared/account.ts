/**
 * 账户顶层类型与录入配对语义（M4 后置校验 / 动态筛选共用）。
 * 只按 Beancount 账户路径的顶层前缀判断，不解析账本内容。
 */

export const ACCOUNT_TYPES = ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

/** 资产负债表类：可作交易中的资金 / 权益载体 */
export const BALANCE_SHEET_ACCOUNT_TYPES: readonly AccountType[] = ['Assets', 'Liabilities', 'Equity']
/** 收支类：损益单侧账户，一笔交易不能全是这类账户 */
export const PL_ACCOUNT_TYPES: readonly AccountType[] = ['Income', 'Expenses']

const ACCOUNT_TYPE_SET = new Set<string>(ACCOUNT_TYPES)

/** 取账户顶层类型；未知前缀返回 undefined（不拦截，保持向后兼容） */
export function accountType(account: string): AccountType | undefined {
  const colon = account.indexOf(':')
  if (colon <= 0) return undefined
  const root = account.slice(0, colon)
  return ACCOUNT_TYPE_SET.has(root) ? (root as AccountType) : undefined
}

/** 是否为收支类账户（Income / Expenses） */
export function isPnlAccountType(type: AccountType | undefined): boolean {
  return type !== undefined && PL_ACCOUNT_TYPES.includes(type)
}

/** 双行录入配对是否有效：两行不能同时是 Income/Expenses（如 餐饮+购物 都属支出）。 */
export function isEntryAccountPairValid(accountA: string, accountB: string): boolean {
  return !(isPnlAccountType(accountType(accountA)) && isPnlAccountType(accountType(accountB)))
}

/** 多行 postings 是否全部为收支账户（无资产/负债/权益账户兜底） */
export function isAllPnlAccounts(accounts: readonly string[]): boolean {
  return accounts.length > 0 && accounts.every((account) => isPnlAccountType(accountType(account)))
}

/**
 * 下拉动态筛选：对行已是收支账户时，把当前行所有收支账户选项过滤掉；
 * 对行是资产/负债/权益或未选时不过滤。
 */
export function filterAccountOptions<T extends { value: string }>(
  options: readonly T[],
  otherAccount?: string
): T[] {
  if (!otherAccount || !isPnlAccountType(accountType(otherAccount))) return [...options]
  return options.filter((option) => !isPnlAccountType(accountType(option.value)))
}
