import { describe, expect, it } from 'vitest'
import { addDecimalStrings, computeBalancingNumber, isZeroDecimal, negateDecimal } from './decimal'

describe('addDecimalStrings（十进制字符串加法）', () => {
  it('浮点等价性：0.1 + 0.2 === 0.3', () => {
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.3')
  })

  it('不同小数位对齐', () => {
    expect(addDecimalStrings('1.5', '0.005')).toBe('1.505')
    expect(addDecimalStrings('0.10', '0.2')).toBe('0.3')
  })

  it('正负相加归零', () => {
    expect(addDecimalStrings('100', '-100')).toBe('0')
    expect(addDecimalStrings('25.5', '-25.5')).toBe('0')
  })

  it('进位', () => {
    expect(addDecimalStrings('999', '1')).toBe('1000')
    expect(addDecimalStrings('9.99', '0.01')).toBe('10')
  })

  it('借位', () => {
    expect(addDecimalStrings('100', '-99.9')).toBe('0.1')
    expect(addDecimalStrings('0.05', '-0.1')).toBe('-0.05')
  })

  it('结果规范化：去前导零 / 尾随零 / -0', () => {
    expect(addDecimalStrings('0.00', '0')).toBe('0')
    expect(addDecimalStrings('5.50', '0')).toBe('5.5')
    expect(addDecimalStrings('000.5', '-0.5')).toBe('0')
  })

  it('非法输入 throw', () => {
    expect(() => addDecimalStrings('abc', '1')).toThrow()
    expect(() => addDecimalStrings('1.2.3', '1')).toThrow()
    expect(() => addDecimalStrings('', '1')).toThrow()
    expect(() => addDecimalStrings('1e5', '1')).toThrow()
    expect(() => addDecimalStrings('1,000', '1')).toThrow()
  })
})

describe('negateDecimal / isZeroDecimal', () => {
  it('符号翻转', () => {
    expect(negateDecimal('5')).toBe('-5')
    expect(negateDecimal('-5')).toBe('5')
    expect(negateDecimal('0')).toBe('0')
  })

  it('isZeroDecimal', () => {
    expect(isZeroDecimal('0')).toBe(true)
    expect(isZeroDecimal('0.00')).toBe(true)
    expect(isZeroDecimal('-0')).toBe(true)
    expect(isZeroDecimal('0.001')).toBe(false)
  })
})

describe('computeBalancingNumber（自动平衡）', () => {
  it('前 n 行之和取反', () => {
    expect(computeBalancingNumber(['100', '-25.5', '-74.5'])).toBe('0')
    expect(computeBalancingNumber(['10', '20'])).toBe('-30')
    expect(computeBalancingNumber(['-10.5', '3'])).toBe('7.5')
  })

  it('空输入 → 0', () => {
    expect(computeBalancingNumber([])).toBe('0')
  })
})
