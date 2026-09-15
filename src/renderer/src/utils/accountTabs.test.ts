/**
 * 账户页分 tab 取数（性能）：分组正确性 + 数组引用复用（memo 表格跳过渲染的前提）。
 */
import { describe, expect, it } from 'vitest'
import type { AccountEntry } from '../../../shared/ipc'
import { ACCOUNT_TAB_KEYS, groupAccountsByTab, reuseUnchangedTabs } from './accountTabs'

function acc(id: number, value: string): AccountEntry {
  return { id, name: `n${id}`, value, description: '' }
}

describe('groupAccountsByTab（科目管理分 tab）', () => {
  it('all 为全量，五大类按 value 首段切分，组内保持原序', () => {
    const bank = acc(1, 'Assets:Bank:CNB')
    const cash = acc(2, 'Assets:Cash')
    const card = acc(3, 'Liabilities:Card')
    const salary = acc(4, 'Income:Salary')
    const food = acc(5, 'Expenses:Food')
    const opening = acc(6, 'Equity:Opening-Balances')
    const configured = [food, bank, card, opening, cash, salary]

    const data = groupAccountsByTab(configured)

    expect(data.all).toBe(configured)
    expect(data.Assets).toEqual([bank, cash])
    expect(data.Liabilities).toEqual([card])
    expect(data.Equity).toEqual([opening])
    expect(data.Income).toEqual([salary])
    expect(data.Expenses).toEqual([food])
  })

  it('未知首段只落在 all（不丢条目），空类为空数组', () => {
    const history = acc(1, 'History:X')
    const data = groupAccountsByTab([history])

    expect(data.all).toEqual([history])
    for (const key of ACCOUNT_TAB_KEYS) {
      if (key !== 'all') expect(data[key]).toEqual([])
    }
  })
})

describe('reuseUnchangedTabs（数组引用复用）', () => {
  it('内容相同的 tab 沿用旧引用，内容变化的 tab 用新引用', () => {
    const bank = acc(1, 'Assets:Bank:CNB')
    const food = acc(2, 'Expenses:Food')
    const prev = groupAccountsByTab([bank, food])

    // 只改 Expenses 那一行（Assets 行对象引用不变）
    const editedFood = { ...food, name: '餐饮' }
    const next = groupAccountsByTab([bank, editedFood])
    const merged = reuseUnchangedTabs(prev, next)

    expect(merged.all).not.toBe(prev.all) // 全量含被改的行
    expect(merged.Assets).toBe(prev.Assets) // 未受影响 → 复用，memo 表格据此跳过渲染
    expect(merged.Expenses).not.toBe(prev.Expenses)
    expect(merged.Liabilities).toBe(prev.Liabilities) // 空组同样复用
  })

  it('内容相同但数组是新建的，也判为未变化', () => {
    const bank = acc(1, 'Assets:Bank:CNB')
    const prev = groupAccountsByTab([bank])
    const next = groupAccountsByTab([bank])

    expect(next.Assets).not.toBe(prev.Assets)
    expect(reuseUnchangedTabs(prev, next).Assets).toBe(prev.Assets)
  })

  it('行数或顺序变化时判为已变化', () => {
    const a = acc(1, 'Assets:A')
    const b = acc(2, 'Assets:B')
    const prev = groupAccountsByTab([a])
    const added = reuseUnchangedTabs(prev, groupAccountsByTab([a, b]))
    const reordered = reuseUnchangedTabs(prev, groupAccountsByTab([b, a]))

    expect(added.Assets).not.toBe(prev.Assets)
    expect(reordered.Assets).not.toBe(prev.Assets)
    expect(added.Assets).toEqual([a, b])
  })
})
