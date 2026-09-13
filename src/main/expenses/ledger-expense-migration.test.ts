import { describe, expect, it } from 'vitest'
import {
  EXPENSE_ACCOUNT_RENAMES,
  classifyExpense,
  flattenExpenseTaxonomy
} from './expense-taxonomy'
import {
  buildExpenseAccountLibrary,
  rewriteExpenseAccounts
} from './ledger-expense-migration'

const SOURCE = [
  'option "title" "BeanWise"',
  'option "operating_currency" "CNY"',
  '',
  '2020-07-01 open Assets:Bank:CNB',
  '2020-07-01 open Expenses:Uncategorized',
  '',
  '2020-07-02 * "麦当劳" "早餐"',
  '  id: "bw-1"',
  '  time: "2020-07-02 08:00:00"',
  '  Expenses:Uncategorized  10.00 CNY',
  '  Assets:Bank:CNB  -10.00 CNY',
  '',
  '2020-07-03 * "蚂蚁财富-基金销售" "买入"',
  '  id: "bw-2"',
  '  time: "2020-07-03 10:00:00"',
  '  Expenses:InvestmentLoss  20.00 CNY',
  '  Assets:Bank:CNB  -20.00 CNY',
  ''
].join('\n')

describe('rewriteExpenseAccounts', () => {
  it('classifies uncategorized postings without touching id, time, amount or counterparty', () => {
    const result = rewriteExpenseAccounts(SOURCE, classifyExpense, EXPENSE_ACCOUNT_RENAMES)

    expect(result.changedPostings).toBe(1)
    expect(result.content).toContain('  Expenses:Life:Food:Breakfast  10.00 CNY')
    expect(result.content).toContain('  id: "bw-1"')
    expect(result.content).toContain('  time: "2020-07-02 08:00:00"')
    expect(result.content).toContain('  Assets:Bank:CNB  -10.00 CNY')
    expect(result.content).toContain('  Expenses:InvestmentLoss  20.00 CNY')
  })

  it('replaces expense open directives with one canonical block at the earliest usage date', () => {
    const result = rewriteExpenseAccounts(SOURCE, classifyExpense, EXPENSE_ACCOUNT_RENAMES)

    expect(result.content).toContain('2020-07-02 open Expenses:Life:Food:Breakfast')
    expect(result.content).not.toContain('open Expenses:Uncategorized')
    expect(result.content.indexOf('open Expenses:Life:Food:Breakfast')).toBeLessThan(
      result.content.indexOf('2020-07-02 * "麦当劳"')
    )
  })

  it('is idempotent', () => {
    const once = rewriteExpenseAccounts(SOURCE, classifyExpense, EXPENSE_ACCOUNT_RENAMES)
    const twice = rewriteExpenseAccounts(once.content, classifyExpense, EXPENSE_ACCOUNT_RENAMES)

    expect(twice.changedPostings).toBe(0)
    expect(twice.content).toBe(once.content)
  })

  it('preserves CRLF line endings', () => {
    const result = rewriteExpenseAccounts(SOURCE.replace(/\n/g, '\r\n'), classifyExpense, EXPENSE_ACCOUNT_RENAMES)
    expect(result.content).toContain('\r\n')
    expect(result.content.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('buildExpenseAccountLibrary', () => {
  it('keeps non-expense and special investment accounts while replacing the flat expense library', () => {
    const accounts = flattenExpenseTaxonomy()
    const existing = [
      { id: 1, name: '银行', value: 'Assets:Bank:CNB' },
      { id: 2, name: '餐饮-消费', value: 'Expenses:Food' },
      { id: 3, name: '投资亏损-消费', value: 'Expenses:InvestmentLoss' }
    ]

    const result = buildExpenseAccountLibrary(existing, accounts)

    expect(result.find((entry) => entry.value === 'Assets:Bank:CNB')?.id).toBe(1)
    expect(result.some((entry) => entry.value === 'Expenses:Food')).toBe(false)
    expect(result.find((entry) => entry.value === 'Expenses:InvestmentLoss')?.id).toBe(3)
    expect(result.find((entry) => entry.value === 'Expenses:Life:Food:Breakfast')).toMatchObject({
      name: '生活消费 / 餐饮 / 早餐'
    })
    expect(new Set(result.map((entry) => entry.value)).size).toBe(result.length)
  })
})
