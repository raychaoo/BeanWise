import { describe, expect, it } from 'vitest'
import type { AccountOption } from '../../stores/ledger'
import { filterEntryAccountOptions } from './accountOptions'

const options: AccountOption[] = [
  { label: '银行卡', value: 'Assets:Bank:CNB' },
  { label: '餐饮', value: 'Expenses:Food' },
  { label: '交通', value: 'Expenses:Travel' }
]

describe('filterEntryAccountOptions', () => {
  it('双行：另一行是收支账户时仍过滤收支，保持既有约束', () => {
    const result = filterEntryAccountOptions(
      options,
      [{ account: 'Expenses:Food' }, {}],
      1
    )
    expect(result.map((o) => o.value)).toEqual(['Assets:Bank:CNB'])
  })

  it('多行：其它行已有资产账户时，本行可选收支账户', () => {
    const result = filterEntryAccountOptions(
      options,
      [{ account: 'Expenses:Uncategorized' }, { account: 'Expenses:Daily' }, { account: 'Assets:Bank:CNB' }],
      0
    )
    expect(result.map((o) => o.value)).toEqual(['Assets:Bank:CNB', 'Expenses:Food', 'Expenses:Travel'])
  })

  it('多行：其它行全是收支账户时，本行必须保留一个资产/负债/权益账户', () => {
    const result = filterEntryAccountOptions(
      options,
      [{ account: 'Expenses:Food' }, { account: 'Expenses:Food' }, {}],
      2
    )
    expect(result.map((o) => o.value)).toEqual(['Assets:Bank:CNB'])
  })
})
