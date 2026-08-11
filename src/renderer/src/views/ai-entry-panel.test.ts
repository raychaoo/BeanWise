/**
 * M7-T4/T5：AiEntryPanel / 填表映射纯函数测试（node 环境无 DOM，组件渲染由 E2E 覆盖——
 * 同 entry-form.test.ts 约定；交互流见 Task 6 e2e/ai-entry.spec.ts）。
 */
import { describe, expect, it } from 'vitest'
import { canGenerate, formatDraftSummary } from './AiEntryPanel'

describe('canGenerate（生成按钮可用性）', () => {
  it('空/纯空白 → false；非空 → true', () => {
    expect(canGenerate('')).toBe(false)
    expect(canGenerate('   ')).toBe(false)
    expect(canGenerate('午饭 25.5')).toBe(true)
  })
})

describe('formatDraftSummary（草稿卡片摘要）', () => {
  it('头部与记账行拼接', () => {
    expect(formatDraftSummary({
      date: '2026-08-11',
      flag: '!',
      payee: '测试',
      narration: '午饭',
      postings: [
        { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
        { account: 'Assets:Bank:CNB', number: '-25.50', currency: 'CNY' }
      ]
    })).toContain('Expenses:Food 25.50 CNY')
  })

  it('无 payee/narration 不输出空位', () => {
    const summary = formatDraftSummary({
      date: '2026-08-11',
      postings: [
        { account: 'Expenses:Food', number: '1', currency: 'CNY' },
        { account: 'Assets:Bank:CNB', number: '-1', currency: 'CNY' }
      ]
    })
    expect(summary).not.toContain('undefined')
    expect(summary).toContain('2026-08-11')
  })
})
