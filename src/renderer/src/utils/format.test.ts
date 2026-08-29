/**
 * formatAmount（批次 B Task 1）：千分位插入为纯字符串处理，禁 Number/parseFloat（精度红线）。
 */
import { describe, expect, it } from 'vitest'
import { formatAmount } from './format'

describe('formatAmount（金额千分位）', () => {
  it('整数+小数插入千分位', () => {
    expect(formatAmount('1234567.89')).toBe('1,234,567.89')
    expect(formatAmount('12345678')).toBe('12,345,678')
    expect(formatAmount('999.99')).toBe('999.99')
  })

  it('负数原样带符号', () => {
    expect(formatAmount('-1234.5')).toBe('-1,234.5')
    expect(formatAmount('-1000000')).toBe('-1,000,000')
  })

  it('0 与小数值原样', () => {
    expect(formatAmount('0')).toBe('0')
    expect(formatAmount('-0')).toBe('-0')
    expect(formatAmount('12.3456')).toBe('12.3456')
  })

  it('非法输入返回 —', () => {
    expect(formatAmount('abc')).toBe('—')
    expect(formatAmount('1..2')).toBe('—')
    expect(formatAmount('12px')).toBe('—')
  })

  it('空值返回 —', () => {
    expect(formatAmount(null)).toBe('—')
    expect(formatAmount(undefined)).toBe('—')
    expect(formatAmount('')).toBe('—')
    expect(formatAmount('   ')).toBe('—')
  })
})
