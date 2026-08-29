/**
 * balanceHintState（批次 B Task 3）：录入平衡提示纯函数。
 * 末行空 → 预告自动平衡值；全行有值 → 平衡/差额；无金额或非法 → 'none'（非法交给表单校验）。
 */
import { describe, expect, it } from 'vitest'
import { balanceHintState } from './entry/balanceState'

describe('balanceHintState（录入平衡提示）', () => {
  it('前 n-1 行有值末行空 → 将自动平衡为 X（formatAmount 千分位）', () => {
    expect(balanceHintState([{ number: '25.50' }, {}])).toEqual({ kind: 'diff', text: '将自动平衡为 -25.5' })
    expect(balanceHintState([{ number: '1000' }, { number: '2000' }, {}])).toEqual({
      kind: 'diff',
      text: '将自动平衡为 -3,000'
    })
  })

  it('全部行有值且和为 0 → 借贷已平衡', () => {
    expect(balanceHintState([{ number: '25.50' }, { number: '-25.50' }])).toEqual({
      kind: 'balanced',
      text: '借贷已平衡'
    })
    expect(balanceHintState([{ number: '0' }, { number: '0' }])).toEqual({
      kind: 'balanced',
      text: '借贷已平衡'
    })
  })

  it('全部行有值但和不为 0 → 差额 X', () => {
    expect(balanceHintState([{ number: '100' }, { number: '-99' }])).toEqual({ kind: 'diff', text: '差额 1' })
  })

  it('无任何金额 → none', () => {
    expect(balanceHintState([{}, {}])).toEqual({ kind: 'none', text: '' })
    expect(balanceHintState([{ number: '' }, { number: null }])).toEqual({ kind: 'none', text: '' })
    expect(balanceHintState(undefined)).toEqual({ kind: 'none', text: '' })
  })

  it('部分输入（末行有值、前段有空行）→ none', () => {
    expect(balanceHintState([{}, { number: '5' }])).toEqual({ kind: 'none', text: '' })
  })

  it('金额非法 → none（交给表单校验，不抛错）', () => {
    expect(balanceHintState([{ number: 'abc' }, {}])).toEqual({ kind: 'none', text: '' })
    expect(balanceHintState([{ number: '1' }, { number: '1..2' }])).toEqual({ kind: 'none', text: '' })
    expect(() => balanceHintState([{ number: 'abc' }, { number: 'x' }])).not.toThrow()
  })
})
