/**
 * 录入视图接线冒烟：自动平衡决策纯函数 nextBalancingNumber（组件渲染由 E2E 覆盖——
 * vitest 为 node 环境，antd 渲染依赖 DOM；computeBalancingNumber 本身已在 shared 单测覆盖）。
 */
import { describe, expect, it } from 'vitest'
import { nextBalancingNumber } from './EntryFormView'
import { formValuesToEntryParams, draftToFormValues } from './entryFormValues'

describe('nextBalancingNumber（录入视图自动平衡决策）', () => {
  it('末行留空 → 前 n-1 行之和取反（结果规范化去尾随零）', () => {
    expect(nextBalancingNumber([{ number: '25.50' }, { number: undefined }])).toBe('-25.5')
    expect(nextBalancingNumber([{ number: '10' }, { number: '20' }, {}])).toBe('-30')
  })

  it('其余行和为 0 也写 0（避免空金额 posting 导致解析失败回滚）', () => {
    expect(nextBalancingNumber([{ number: '0' }, {}])).toBe('0')
    expect(nextBalancingNumber([{ number: '100' }, { number: '-100' }, {}])).toBe('0')
  })

  it('前 n-1 行全空不写（避免挂载时写入的 0 被当成用户输入，挡住真实补差）', () => {
    expect(nextBalancingNumber([{}, {}])).toBeUndefined()
    expect(nextBalancingNumber([{ number: '' }, { number: null }])).toBeUndefined()
  })

  it('末行非空（用户输入中）不动', () => {
    expect(nextBalancingNumber([{ number: '25.50' }, { number: '-25.50' }])).toBeUndefined()
  })

  it('末行为空串同样补差（空串视为未输入）', () => {
    expect(nextBalancingNumber([{ number: '1' }, { number: '' }])).toBe('-1')
    expect(nextBalancingNumber([{ number: '1' }, { number: null }])).toBe('-1')
  })

  it('行数不足 2 不动', () => {
    expect(nextBalancingNumber([])).toBeUndefined()
    expect(nextBalancingNumber([{}])).toBeUndefined()
    expect(nextBalancingNumber(undefined)).toBeUndefined()
  })

  it('中间行空值跳过（视为 0）', () => {
    expect(nextBalancingNumber([{ number: '10' }, {}, { number: undefined }])).toBe('-10')
  })

  it('非法金额不抛错（交给表单校验提示）', () => {
    expect(nextBalancingNumber([{ number: 'abc' }, {}])).toBeUndefined()
    expect(() => nextBalancingNumber([{ number: '1..2' }, {}])).not.toThrow()
  })
})

describe('entryFormValues 时间与元数据', () => {
  it('编辑回填 date 使用 time 的秒级值，提交时原样输出 YYYY-MM-DD HH:mm:ss', () => {
    const values = draftToFormValues({
      id: 'bw-keep-id',
      date: '2026-09-12',
      time: '2026-09-12 18:20:30',
      flag: '*',
      postings: [
        { account: 'Expenses:Food', number: '10', currency: 'CNY' },
        { account: 'Assets:Cash', number: '-10', currency: 'CNY' }
      ]
    })
    const params = formValuesToEntryParams(values, { id: 'bw-keep-id' })
    expect(params.id).toBe('bw-keep-id')
    expect(params.date).toBe('2026-09-12')
    expect(params.time).toBe('2026-09-12 18:20:30')
  })

  it('没有 time 的历史数据回填 00:00:00', () => {
    const values = draftToFormValues({
      date: '2026-01-02',
      postings: [
        { account: 'Expenses:Food', number: '1', currency: 'CNY' },
        { account: 'Assets:Cash', number: '-1', currency: 'CNY' }
      ]
    })
    expect(formValuesToEntryParams(values).time).toBe('2026-01-02 00:00:00')
  })
})
