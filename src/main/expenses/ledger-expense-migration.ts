export interface ExpenseClassificationLike {
  account: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ExpenseClassifierLike = (
  payee: string,
  narration: string
) => ExpenseClassificationLike

export interface ExpenseAccountDefinitionLike {
  path: string
  label: string
  parent: string | null
  leaf: boolean
}

export interface ExpenseAccountEntryLike {
  id: number
  name: string
  value: string
  description?: string
  enabled?: boolean
  counterparty?: boolean
}

export interface ExpenseRewriteResult {
  content: string
  changedPostings: number
  accountCounts: Record<string, number>
  usedAccountDates: Record<string, string>
  skippedInvestmentLoss: number
}

const TRANSACTION_RE = /^(\d{4}-\d{2}-\d{2})\s+\*\s+(.*)$/
const EXPENSE_POSTING_RE = /^(\s+)Expenses:([A-Za-z0-9:]+)(\s+.+)$/
const EXPENSE_OPEN_RE = /^\d{4}-\d{2}-\d{2}\s+open\s+Expenses:[A-Za-z0-9:]+\s*$/
const STRING_RE = /"((?:\\.|[^"])*)"/g

function parseTransactionText(line: string): { date: string; payee: string; narration: string } | null {
  const match = TRANSACTION_RE.exec(line)
  if (!match) return null
  const strings: string[] = []
  STRING_RE.lastIndex = 0
  let item: RegExpExecArray | null
  while ((item = STRING_RE.exec(match[2])) !== null) strings.push(item[1])
  return {
    date: match[1],
    payee: strings.length >= 2 ? strings[0] : '',
    narration: strings.length >= 2 ? strings[1] : (strings[0] ?? '')
  }
}

function minDate(current: string | undefined, next: string): string {
  return current === undefined || next < current ? next : current
}

/**
 * 把账本中所有 Expenses:* posting 映射到新科目树。
 * 只改账户名和 open 行，不动 id、time、金额、币种和其他 posting。
 */
export function rewriteExpenseAccounts(
  content: string,
  classifier: ExpenseClassifierLike,
  renames: Readonly<Record<string, string>>
): ExpenseRewriteResult {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const accountCounts: Record<string, number> = {}
  const usedAccountDates: Record<string, string> = {}
  let changedPostings = 0
  let skippedInvestmentLoss = 0
  let transaction: ReturnType<typeof parseTransactionText> = null

  const output: string[] = []
  for (const line of lines) {
    if (EXPENSE_OPEN_RE.test(line)) continue

    const parsedTransaction = parseTransactionText(line)
    if (parsedTransaction) {
      transaction = parsedTransaction
      output.push(line)
      continue
    }

    if (!transaction || !EXPENSE_POSTING_RE.test(line)) {
      output.push(line)
      if (line.trim() === '' || /^\d{4}-\d{2}-\d{2}\s+open\s+/.test(line)) transaction = null
      continue
    }

    const match = EXPENSE_POSTING_RE.exec(line)!
    const currentAccount = `Expenses:${match[2]}`
    let targetAccount = currentAccount

    if (currentAccount === 'Expenses:InvestmentLoss') {
      skippedInvestmentLoss += 1
    } else if (renames[currentAccount]) {
      const classified = classifier(transaction.payee, transaction.narration)
      targetAccount =
        classified.confidence !== 'low' && classified.account !== 'Expenses:Other'
          ? classified.account
          : renames[currentAccount]
    }

    if (targetAccount !== currentAccount) {
      changedPostings += 1
      output.push(`${match[1]}${targetAccount}${match[3]}`)
    } else {
      output.push(line)
    }
    accountCounts[targetAccount] = (accountCounts[targetAccount] ?? 0) + 1
    usedAccountDates[targetAccount] = minDate(usedAccountDates[targetAccount], transaction.date)
  }

  const openLines = Object.entries(usedAccountDates)
    .sort(([accountA, dateA], [accountB, dateB]) => dateA.localeCompare(dateB) || accountA.localeCompare(accountB))
    .map(([account, date]) => `${date} open ${account}`)

  if (openLines.length > 0) {
    const firstTransactionIndex = output.findIndex((line) => TRANSACTION_RE.test(line))
    let insertAt = firstTransactionIndex === -1 ? output.length : firstTransactionIndex
    while (insertAt > 0 && output[insertAt - 1].trim() === '') insertAt -= 1
    output.splice(insertAt, 0, ...openLines)
  }

  return {
    content: output.join(newline),
    changedPostings,
    accountCounts,
    usedAccountDates,
    skippedInvestmentLoss
  }
}

/** 从叶子科目定义生成账户库；保留非支出账户和 investmentLoss 待审计账户。 */
export function buildExpenseAccountLibrary(
  existing: readonly ExpenseAccountEntryLike[],
  accounts: readonly ExpenseAccountDefinitionLike[]
): ExpenseAccountEntryLike[] {
  const taxonomyByPath = new Map(
    accounts.filter((account) => account.leaf).map((account) => [account.path, account])
  )
  const labelByPath = new Map<string, string>()
  for (const account of accounts) labelByPath.set(account.path, account.label)

  const fullLabel = (path: string): string => {
    const parts = path.split(':')
    const labels: string[] = []
    for (let i = 2; i <= parts.length; i++) {
      const partPath = parts.slice(0, i).join(':')
      labels.push(labelByPath.get(partPath) ?? parts[i - 1])
    }
    return labels.join(' / ')
  }

  const preserved = existing.filter(
    (entry) => !entry.value.startsWith('Expenses:') || entry.value === 'Expenses:InvestmentLoss'
  )
  const existingByIdentity = new Map(preserved.map((entry) => [entry.value, entry]))
  const nextId = preserved.length > 0 ? Math.max(...preserved.map((entry) => entry.id)) + 1 : 1
  let allocatedId = nextId
  const result = [...preserved]

  for (const account of [...taxonomyByPath.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const old = existingByIdentity.get(account.path)
    const name = fullLabel(account.path)
    result.push({
      ...(old ?? {}),
      id: old?.id ?? allocatedId++,
      name,
      value: account.path,
      description: `支出科目：${name}`
    })
  }

  return result
}
