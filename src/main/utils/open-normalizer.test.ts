import { describe, expect, it } from 'vitest'
import { normalizeAccountOpens } from './open-normalizer'

describe('normalizeAccountOpens（open 日期校正）', () => {
  it('把晚于最早交易日期的 open 提前', () => {
    const content = [
      'option "operating_currency" "CNY"',
      '',
      '2026-08-22 open Assets:Bank:ZSYH',
      '2026-08-22 open Assets:WeChat:Pay',
      '2026-08-22 *',
      '  Assets:Bank:ZSYH  100 CNY',
      '  Assets:WeChat:Pay  -100 CNY'
    ].join('\n') + '\n'
    const next = normalizeAccountOpens(content, ['Assets:Bank:ZSYH', 'Assets:WeChat:Pay'], '2026-05-22')
    expect(next).toContain('2026-05-22 open Assets:Bank:ZSYH')
    expect(next).toContain('2026-05-22 open Assets:WeChat:Pay')
  })

  it('缺失的 open 账户补在末尾', () => {
    const next = normalizeAccountOpens('2026-01-01 open Assets:WeChat:Pay\n', ['Expenses:Transfer', 'Assets:WeChat:Pay'], '2026-05-22')
    expect(next).toContain('2026-05-22 open Expenses:Transfer')
    expect(next.indexOf('open Expenses:Transfer')).toBeGreaterThan(next.indexOf('open Assets:WeChat:Pay'))
  })

  it('空账本也能补 open', () => {
    const next = normalizeAccountOpens('', ['Expenses:Shopping'], '2026-05-22')
    expect(next).toBe('2026-05-22 open Expenses:Shopping\n')
  })
})
