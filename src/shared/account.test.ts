import { describe, expect, it } from 'vitest'
import {
  accountType,
  filterAccountOptions,
  isAllPnlAccounts,
  isEntryAccountPairValid
} from './account'

describe('accountType', () => {
  it('按账户路径顶层前缀识别类型；未知前缀返回 undefined', () => {
    expect(accountType('Expenses:Food')).toBe('Expenses')
    expect(accountType('Assets:Bank:CNB')).toBe('Assets')
    expect(accountType('Income:Salary')).toBe('Income')
    expect(accountType('Foo:Bar')).toBeUndefined()
  })
})

describe('isEntryAccountPairValid / isAllPnlAccounts', () => {
  it('餐饮 + 购物（同是支出）拒绝', () => {
    expect(isEntryAccountPairValid('Expenses:Food', 'Expenses:Shopping')).toBe(false)
  })

  it('支出 + 收入同样拒绝（缺少资产/负债/权益资金载体）', () => {
    expect(isEntryAccountPairValid('Expenses:Food', 'Income:Salary')).toBe(false)
  })

  it('支出 + 资产、资产 + 资产均通过', () => {
    expect(isEntryAccountPairValid('Expenses:Food', 'Assets:Cash')).toBe(true)
    expect(isEntryAccountPairValid('Assets:Bank:CNB', 'Assets:Cash')).toBe(true)
  })

  it('多行 postings 全部为收支账户时拒绝', () => {
    expect(isAllPnlAccounts(['Expenses:Food', 'Income:Salary', 'Expenses:Shopping'])).toBe(true)
    expect(isAllPnlAccounts(['Expenses:Food', 'Assets:Cash'])).toBe(false)
  })
})

describe('filterAccountOptions', () => {
  const options = [
    { value: 'Expenses:Food', label: '餐饮' },
    { value: 'Expenses:Shopping', label: '购物' },
    { value: 'Income:Salary', label: '工资' },
    { value: 'Assets:Bank:CNB', label: '银行卡' },
    { value: 'Liabilities:CreditCard', label: '信用卡' },
    { value: 'Equity:Opening', label: '期初' }
  ]

  it('对行未选时全部保留', () => {
    expect(filterAccountOptions(options)).toEqual(options)
  })

  it('对行已是支出账户 → 过滤掉全部收支账户', () => {
    expect(filterAccountOptions(options, 'Expenses:Food').map((o) => o.value)).toEqual([
      'Assets:Bank:CNB',
      'Liabilities:CreditCard',
      'Equity:Opening'
    ])
  })

  it('对行是资产账户 → 不做收支过滤', () => {
    expect(filterAccountOptions(options, 'Assets:Bank:CNB')).toEqual(options)
  })
})
