/**
 * 记账方向判定单测（核心回归：用户把「收入账户」填在第一行时，落账方向必须正确——收入记负、
 * 资产记正；反过来把资产填第一行也同样正确）。
 */
import { describe, expect, it } from 'vitest'
import {
  applyPostingSign,
  buildEntryPostings,
  displaySignedNumber,
  postingEffectLabel,
  resolvePostingSigns
} from './postingDirection'

describe('resolvePostingSigns（按账户类型定向）', () => {
  it('第一行是收入 → 收入行记负、另一行记正（无论另一行是什么）', () => {
    expect(resolvePostingSigns('Income:投资盈利', 'Assets:招商银行')).toEqual([-1, 1])
    expect(resolvePostingSigns('Income:工资', 'Liabilities:花呗')).toEqual([-1, 1])
  })

  it('第二行是支出 → 支出行记正、第一行记负', () => {
    expect(resolvePostingSigns('Assets:招商银行', 'Expenses:餐饮')).toEqual([-1, 1])
  })

  it('第一行是支出 → 支出行记正、另一行记负', () => {
    expect(resolvePostingSigns('Expenses:餐饮', 'Assets:招商银行')).toEqual([1, -1])
  })

  it('第二行是收入 → 收入行记负、另一行记正', () => {
    expect(resolvePostingSigns('Assets:招商银行', 'Income:投资盈利')).toEqual([1, -1])
  })

  it('纯资产/负债/权益（转账）→ 按行序：第一行转入 +、第二行转出 −', () => {
    expect(resolvePostingSigns('Assets:招商银行', 'Assets:支付宝')).toEqual([1, -1])
    expect(resolvePostingSigns('Liabilities:花呗', 'Assets:招商银行')).toEqual([1, -1])
  })

  it('账户未填 / 未知前缀 → 退回默认（第一行 +、第二行 −）', () => {
    expect(resolvePostingSigns(undefined, undefined)).toEqual([1, -1])
    expect(resolvePostingSigns('Unknown:X', '')).toEqual([1, -1])
  })
})

describe('postingEffectLabel（行头语义短语）', () => {
  it('收入：记负 = 收入增加，记正 = 收入减少', () => {
    expect(postingEffectLabel('Income:投资盈利', -1)).toBe('收入增加')
    expect(postingEffectLabel('Income:投资盈利', 1)).toBe('收入减少')
  })

  it('支出：记正 = 支出增加，记负 = 支出减少', () => {
    expect(postingEffectLabel('Expenses:餐饮', 1)).toBe('支出增加')
    expect(postingEffectLabel('Expenses:餐饮', -1)).toBe('支出减少')
  })

  it('资产/负债/权益：记正 = 资金增加，记负 = 资金减少', () => {
    expect(postingEffectLabel('Assets:招商银行', 1)).toBe('资金增加')
    expect(postingEffectLabel('Assets:招商银行', -1)).toBe('资金减少')
    expect(postingEffectLabel('Liabilities:花呗', -1)).toBe('资金减少')
  })
})

describe('applyPostingSign（取绝对值后套用符号）', () => {
  it('正数按符号落账', () => {
    expect(applyPostingSign('20', 1)).toBe('20')
    expect(applyPostingSign('20', -1)).toBe('-20')
  })

  it('用户手输负号也会被归一（方向由账户类型决定）', () => {
    expect(applyPostingSign('-20', 1)).toBe('20')
    expect(applyPostingSign('-20', -1)).toBe('-20')
  })

  it('0 与空值', () => {
    expect(applyPostingSign('0', -1)).toBe('0')
    expect(applyPostingSign('', -1)).toBe('')
  })
})

describe('displaySignedNumber（金额框显示）', () => {
  it('按符号呈现', () => {
    expect(displaySignedNumber('20', -1)).toBe('-20')
    expect(displaySignedNumber('20', 1)).toBe('20')
    expect(displaySignedNumber('-20', 1)).toBe('20')
  })

  it('0 / 空值 / 输入中非法串原样', () => {
    expect(displaySignedNumber('0', -1)).toBe('0')
    expect(displaySignedNumber('0.00', -1)).toBe('0.00')
    expect(displaySignedNumber('', -1)).toBe('')
    expect(displaySignedNumber(undefined, -1)).toBe('')
    expect(displaySignedNumber('1.', -1)).toBe('1.')
    expect(displaySignedNumber('-', -1)).toBe('-')
  })
})

describe('buildEntryPostings（表单两行 → 落账 postings）', () => {
  it('回归：投资盈利填在第一行 → 收入记负、银行记正（不再是亏损）', () => {
    expect(
      buildEntryPostings([
        { account: 'Income:投资盈利', number: '20', currency: 'CNY' },
        { account: 'Assets:招商银行储蓄卡(6156)', number: '-20', currency: 'CNY' }
      ])
    ).toEqual([
      { account: 'Income:投资盈利', number: '-20', currency: 'CNY' },
      { account: 'Assets:招商银行储蓄卡(6156)', number: '20', currency: 'CNY' }
    ])
  })

  it('回归：银行填在第一行、投资盈利在第二行 → 结果同上（顺序无关）', () => {
    expect(
      buildEntryPostings([
        { account: 'Assets:招商银行储蓄卡(6156)', number: '20', currency: 'CNY' },
        { account: 'Income:投资盈利', number: '-20', currency: 'CNY' }
      ])
    ).toEqual([
      { account: 'Assets:招商银行储蓄卡(6156)', number: '20', currency: 'CNY' },
      { account: 'Income:投资盈利', number: '-20', currency: 'CNY' }
    ])
  })

  it('支出：第一行 餐饮 + 第二行 银行 → 支出记正、银行记负', () => {
    expect(
      buildEntryPostings([
        { account: 'Expenses:餐饮', number: '25.50', currency: 'CNY' },
        { account: 'Assets:招商银行', number: '-25.50', currency: 'CNY' }
      ])
    ).toEqual([
      { account: 'Expenses:餐饮', number: '25.50', currency: 'CNY' },
      { account: 'Assets:招商银行', number: '-25.50', currency: 'CNY' }
    ])
  })

  it('转账：两行都是资产，按行序定向', () => {
    expect(
      buildEntryPostings([
        { account: 'Assets:支付宝', number: '100', currency: 'CNY' },
        { account: 'Assets:招商银行', number: '-100', currency: 'CNY' }
      ])
    ).toEqual([
      { account: 'Assets:支付宝', number: '100', currency: 'CNY' },
      { account: 'Assets:招商银行', number: '-100', currency: 'CNY' }
    ])
  })

  it('缺字段补空串；非两行不做定向（多行场景原样透传）', () => {
    expect(buildEntryPostings([{ account: 'Assets:现金', number: '' }])).toEqual([
      { account: 'Assets:现金', number: '', currency: '' }
    ])
    expect(
      buildEntryPostings([
        { account: 'Income:投资盈利', number: '10', currency: 'CNY' },
        { account: 'Assets:银行', number: '-10', currency: 'CNY' },
        { account: 'Assets:现金', number: '0', currency: 'CNY' }
      ]).map((p) => p.number)
    ).toEqual(['10', '-10', '0'])
  })

  it('preserveSigns：编辑回填时正负号原样保留，不再按账户类型翻转', () => {
    expect(
      buildEntryPostings(
        [
          { account: 'Expenses:餐饮', number: '-10.00', currency: 'CNY' },
          { account: 'Assets:银行', number: '10.00', currency: 'CNY' }
        ],
        { preserveSigns: true }
      ).map((p) => p.number)
    ).toEqual(['-10.00', '10.00'])
  })

  it('counterparty 透传并 trim；空白视为未填、不落该字段（ADR 23）', () => {
    expect(
      buildEntryPostings([
        { account: 'Assets:Receivables:Lend', number: '5000', currency: 'CNY', counterparty: '  李志全  ' },
        { account: 'Assets:Bank:ZSYH', number: '-5000', currency: 'CNY' }
      ])
    ).toEqual([
      { account: 'Assets:Receivables:Lend', number: '5000', currency: 'CNY', counterparty: '李志全' },
      { account: 'Assets:Bank:ZSYH', number: '-5000', currency: 'CNY' }
    ])
    expect(
      buildEntryPostings([
        { account: 'Assets:Receivables:Lend', number: '1', currency: 'CNY', counterparty: '   ' },
        { account: 'Assets:Bank:ZSYH', number: '-1', currency: 'CNY' }
      ])[0]
    ).not.toHaveProperty('counterparty')
  })
})
