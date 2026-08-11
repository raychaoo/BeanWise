/**
 * M7-T1：AI 输出 schema（zod 4 单源三用）测试。
 * 字段口径对齐 entry-serializer.ts：日期/账户/金额/货币/payee/narration/postings 2~20 行。
 * 宽容分界：JSON number 金额 → 十进制字符串；严格分界：语义字段非法一律拒绝。
 */
import { describe, expect, it } from 'vitest'
import { addEntriesToolSchema, AI_TOOL, AI_TOOL_NAME, formatAiValidationError } from './ai-schema'

const validEntry = {
  date: '2026-08-11',
  flag: '*',
  payee: '测试',
  narration: '午饭',
  postings: [
    { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
    { account: 'Assets:Bank:CNB', number: '-25.50', currency: 'CNY' }
  ]
}

describe('addEntriesToolSchema（AI 输出校验）', () => {
  it('合法输出通过，金额保持十进制字符串', () => {
    const r = addEntriesToolSchema.safeParse({ entries: [validEntry] })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.entries[0].postings[0].number).toBe('25.50')
      expect(r.data.entries[0].date).toBe('2026-08-11')
    }
  })

  it('JSON number 金额 coerce 为十进制字符串（宽容分界）', () => {
    const r = addEntriesToolSchema.safeParse({
      entries: [{
        ...validEntry,
        postings: [
          { account: 'Expenses:Food', number: 12.5, currency: 'CNY' },
          { account: 'Assets:Bank:CNB', number: -12.5, currency: 'CNY' }
        ]
      }]
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.entries[0].postings[0].number).toBe('12.5')
  })

  it('金额非十进制字符串拒绝（严格分界）', () => {
    const r = addEntriesToolSchema.safeParse({
      entries: [{ ...validEntry, postings: [{ account: 'Expenses:Food', number: 'abc', currency: 'CNY' }, { account: 'Assets:Bank:CNB', number: '-25.50', currency: 'CNY' }] }]
    })
    expect(r.success).toBe(false)
  })

  it('日期格式非法拒绝', () => {
    const r = addEntriesToolSchema.safeParse({ entries: [{ ...validEntry, date: '2026-13-40' }] })
    expect(r.success).toBe(false)
  })

  it('账户含空格 / 小写开头 / 缺冒号拒绝', () => {
    expect(addEntriesToolSchema.safeParse({
      entries: [{ ...validEntry, postings: [{ account: 'Expenses Food', number: '1', currency: 'CNY' }, { account: 'Assets:Bank:CNB', number: '-1', currency: 'CNY' }] }]
    }).success).toBe(false)
    expect(addEntriesToolSchema.safeParse({
      entries: [{ ...validEntry, postings: [{ account: 'expenses:food', number: '1', currency: 'CNY' }, { account: 'Assets:Bank:CNB', number: '-1', currency: 'CNY' }] }]
    }).success).toBe(false)
    expect(addEntriesToolSchema.safeParse({
      entries: [{ ...validEntry, postings: [{ account: 'Expenses', number: '1', currency: 'CNY' }, { account: 'Assets:Bank:CNB', number: '-1', currency: 'CNY' }] }]
    }).success).toBe(false)
  })

  it('记账行少于 2 行拒绝', () => {
    const r = addEntriesToolSchema.safeParse({ entries: [{ ...validEntry, postings: [validEntry.postings[0]] }] })
    expect(r.success).toBe(false)
  })

  it('entries 为空数组或超过 10 笔拒绝', () => {
    expect(addEntriesToolSchema.safeParse({ entries: [] }).success).toBe(false)
    const many = { entries: Array.from({ length: 11 }, () => validEntry) }
    expect(addEntriesToolSchema.safeParse(many).success).toBe(false)
  })

  it('flag 非 * / ! 拒绝；缺省通过', () => {
    expect(addEntriesToolSchema.safeParse({ entries: [{ ...validEntry, flag: 'P' }] }).success).toBe(false)
    const noFlag = { ...validEntry }
    delete (noFlag as Record<string, unknown>).flag
    expect(addEntriesToolSchema.safeParse({ entries: [noFlag] }).success).toBe(true)
  })

  it('payee 含控制字符拒绝；空串视为缺省', () => {
    expect(addEntriesToolSchema.safeParse({ entries: [{ ...validEntry, payee: 'a\nb' }] }).success).toBe(false)
    const r = addEntriesToolSchema.safeParse({ entries: [{ ...validEntry, payee: '   ' }] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.entries[0].payee).toBeUndefined()
  })

  it('未知字段被剥离（zod 默认 strip，容忍模型多输出）', () => {
    const r = addEntriesToolSchema.safeParse({ entries: [{ ...validEntry, extra: 'x' }], note: 'y' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('extra' in r.data.entries[0]).toBe(false)
      expect('note' in r.data).toBe(false)
    }
  })

  it('formatAiValidationError 输出中文定位', () => {
    const r = addEntriesToolSchema.safeParse({ entries: [{ ...validEntry, date: '2026-13-40' }] })
    expect(r.success).toBe(false)
    if (!r.success) {
      const msg = formatAiValidationError(r.error)
      expect(msg).toContain('日期')
      expect(msg).toContain('YYYY-MM-DD')
    }
  })
})

describe('AI_TOOL（tool schema 单一来源）', () => {
  it('tool 名与常量一致，parameters 为 JSON Schema 且含 entries', () => {
    expect(AI_TOOL.function.name).toBe(AI_TOOL_NAME)
    const params = AI_TOOL.function.parameters as { type: string; properties: Record<string, { type: string }> }
    expect(params.type).toBe('object')
    expect(params.properties.entries.type).toBe('array')
  })
})
