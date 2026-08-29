/**
 * groupAccountOptions（批次 B Task 2）：账户下拉按五大类分组。
 * 组顺序固定（资产/负债/权益/收入/支出），未知首段归「其他」置底，组内保持原序。
 */
import { describe, expect, it } from 'vitest'
import { groupAccountOptions } from './accountGroup'

describe('groupAccountOptions（账户下拉五大类分组）', () => {
  it('五大类顺序固定 + 其他置底，组内保持原序', () => {
    const options = [
      { label: '餐饮', value: 'Expenses:Food' },
      { label: '银行卡', value: 'Assets:Bank:CNB' },
      { label: '信用卡', value: 'Liabilities:Card' },
      { label: '开账', value: 'Equity:Opening-Balances' },
      { label: '历史:X', value: 'History:X' },
      { label: '现金', value: 'Assets:Cash' },
      { label: '工资', value: 'Income:Salary' }
    ]
    expect(groupAccountOptions(options)).toEqual([
      {
        label: '资产',
        options: [
          { label: '银行卡', value: 'Assets:Bank:CNB' },
          { label: '现金', value: 'Assets:Cash' }
        ]
      },
      { label: '负债', options: [{ label: '信用卡', value: 'Liabilities:Card' }] },
      { label: '权益', options: [{ label: '开账', value: 'Equity:Opening-Balances' }] },
      { label: '收入', options: [{ label: '工资', value: 'Income:Salary' }] },
      { label: '支出', options: [{ label: '餐饮', value: 'Expenses:Food' }] },
      { label: '其他', options: [{ label: '历史:X', value: 'History:X' }] }
    ])
  })

  it('空组不输出（避免 antd Select 渲染空组头）', () => {
    const options = [
      { label: '银行卡', value: 'Assets:Bank:CNB' },
      { label: '历史:X', value: 'History:X' }
    ]
    expect(groupAccountOptions(options)).toEqual([
      { label: '资产', options: [{ label: '银行卡', value: 'Assets:Bank:CNB' }] },
      { label: '其他', options: [{ label: '历史:X', value: 'History:X' }] }
    ])
  })

  it('空输入返回空数组', () => {
    expect(groupAccountOptions([])).toEqual([])
  })
})
