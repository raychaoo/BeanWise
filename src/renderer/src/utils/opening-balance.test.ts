import { describe, expect, it } from 'vitest'
import { addDecimalStrings } from '../../../shared/decimal'
import type { AddEntryParams } from '../../../shared/ipc'
import { buildOpeningBalanceEntry } from './opening-balance'

describe('buildOpeningBalanceEntry', () => {
  it('合法资产账户 → 两行 Equity:Opening-Balances 配对、和为 0、narration/flag 正确', () => {
    const r = buildOpeningBalanceEntry({ account: 'Assets:Bank:CNB', number: '1000.50', currency: 'CNY', date: '2026-08-30' })
    expect('error' in r).toBe(false)
    const entry = r as AddEntryParams
    expect(entry.date).toBe('2026-08-30')
    expect(entry.flag).toBe('*')
    expect(entry.narration).toBe('期初余额')
    expect(entry.postings).toEqual([
      { account: 'Assets:Bank:CNB', number: '1000.50', currency: 'CNY' },
      // computeBalancingNumber 输出遵循 decimal.ts 规范化契约（去尾随零）
      { account: 'Equity:Opening-Balances', number: '-1000.5', currency: 'CNY' }
    ])
    expect(addDecimalStrings(entry.postings[0].number, entry.postings[1].number)).toBe('0')
  })

  it('负数金额 → error（期初余额非负）', () => {
    const r = buildOpeningBalanceEntry({ account: 'Assets:Bank', number: '-100', currency: 'CNY', date: '2026-08-30' })
    expect('error' in r).toBe(true)
  })

  it('Income / Expenses 账户 → error（期初余额只对资产/负债有意义，账户非 PnL）', () => {
    expect('error' in buildOpeningBalanceEntry({ account: 'Income:Salary', number: '100', currency: 'CNY', date: '2026-08-30' })).toBe(true)
    expect('error' in buildOpeningBalanceEntry({ account: 'Expenses:Food', number: '100', currency: 'CNY', date: '2026-08-30' })).toBe(true)
  })

  it('非法金额格式 → error', () => {
    expect('error' in buildOpeningBalanceEntry({ account: 'Assets:Bank', number: '12a', currency: 'CNY', date: '2026-08-30' })).toBe(true)
    expect('error' in buildOpeningBalanceEntry({ account: 'Assets:Bank', number: '1.2.3', currency: 'CNY', date: '2026-08-30' })).toBe(true)
    expect('error' in buildOpeningBalanceEntry({ account: 'Assets:Bank', number: '', currency: 'CNY', date: '2026-08-30' })).toBe(true)
  })

  it('货币为空 → error（产出须满足 AddEntryPosting 契约：货币非空）', () => {
    expect('error' in buildOpeningBalanceEntry({ account: 'Assets:Bank', number: '100', currency: '  ', date: '2026-08-30' })).toBe(true)
  })
})
