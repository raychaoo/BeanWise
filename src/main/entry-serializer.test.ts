import { describe, expect, it } from 'vitest'
import type { AddEntryParams } from '../shared/ipc'
import { serializeEntry, serializeFirstEntryBlock, validateEntryParams } from './entry-serializer'

const valid: AddEntryParams = {
  date: '2026-08-09',
  flag: '*',
  payee: '测试午饭',
  narration: 'M4 E2E',
  postings: [
    { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
    { account: 'Assets:Cash', number: '-25.50', currency: 'CNY' }
  ]
}

describe('serializeEntry', () => {
  it('完整交易输出快照（\n 结尾、无前导空行、posting 两空格缩进）', () => {
    expect(serializeEntry(valid)).toBe(
      '2026-08-09 * "测试午饭" "M4 E2E"\n' +
        '  Expenses:Food  25.50 CNY\n' +
        '  Assets:Cash  -25.50 CNY\n'
    )
  })

  it('无 payee / 无 narration 分支', () => {
    expect(serializeEntry({ ...valid, payee: undefined })).toBe(
      '2026-08-09 * "" "M4 E2E"\n  Expenses:Food  25.50 CNY\n  Assets:Cash  -25.50 CNY\n'
    )
    expect(serializeEntry({ ...valid, narration: undefined })).toBe(
      '2026-08-09 * "测试午饭"\n  Expenses:Food  25.50 CNY\n  Assets:Cash  -25.50 CNY\n'
    )
    expect(serializeEntry({ ...valid, payee: undefined, narration: undefined })).toBe(
      '2026-08-09 *\n  Expenses:Food  25.50 CNY\n  Assets:Cash  -25.50 CNY\n'
    )
  })

  it('flag 缺省默认 *', () => {
    expect(serializeEntry({ ...valid, flag: undefined })).toMatch(/^2026-08-09 \* /)
    expect(serializeEntry({ ...valid, flag: '!' })).toMatch(/^2026-08-09 ! /)
  })

  it('payee/narration 引号转义', () => {
    expect(serializeEntry({ ...valid, payee: '他说 "你好"' })).toMatch(
      /^2026-08-09 \* "他说 \\"你好\\"" /
    )
  })

  it('金额原样输出（不做对齐美化）', () => {
    expect(serializeEntry({ ...valid, postings: [{ account: 'Assets:Cash', number: '-100', currency: 'CNY' }] }))
      .toContain('  Assets:Cash  -100 CNY\n')
  })
})

describe('serializeFirstEntryBlock（首文件：open 行 + 交易块）', () => {
  it('输出快照：open 行按 posting 顺序 + 交易块', () => {
    expect(serializeFirstEntryBlock(valid)).toBe(
      '2026-08-09 open Expenses:Food\n' +
        '2026-08-09 open Assets:Cash\n' +
        '2026-08-09 * "测试午饭" "M4 E2E"\n' +
        '  Expenses:Food  25.50 CNY\n' +
        '  Assets:Cash  -25.50 CNY\n'
    )
  })

  it('重复账户去重', () => {
    const params: AddEntryParams = {
      date: '2026-08-09',
      postings: [
        { account: 'Expenses:Food', number: '10', currency: 'CNY' },
        { account: 'Expenses:Food', number: '5', currency: 'CNY' },
        { account: 'Assets:Cash', number: '-15', currency: 'CNY' }
      ]
    }
    const block = serializeFirstEntryBlock(params)
    expect(block.match(/open /g)).toHaveLength(2)
    expect(block).toContain('2026-08-09 open Expenses:Food')
    expect(block).toContain('2026-08-09 open Assets:Cash')
  })
})

describe('validateEntryParams', () => {
  it('合法入参原样返回', () => {
    expect(validateEntryParams(valid)).toEqual(valid)
  })

  it('缺省字段不出现', () => {
    const r = validateEntryParams({ date: '2026-08-09', postings: valid.postings })
    expect(r).toEqual({ date: '2026-08-09', postings: valid.postings })
  })

  it('日期非法拒绝（格式 / 越界 / 假日期）', () => {
    expect(() => validateEntryParams({ ...valid, date: 'abc' })).toThrow(/日期/)
    expect(() => validateEntryParams({ ...valid, date: '2026/08/09' })).toThrow(/日期/)
    expect(() => validateEntryParams({ ...valid, date: '2026-13-01' })).toThrow(/日期/)
    expect(() => validateEntryParams({ ...valid, date: '2026-02-30' })).toThrow(/日期/)
    expect(() => validateEntryParams({ ...valid, date: 20260809 })).toThrow(/date/)
  })

  it('flag 白名单', () => {
    expect(() => validateEntryParams({ ...valid, flag: 'x' })).toThrow(/flag/)
    expect(() => validateEntryParams({ ...valid, flag: '?' })).toThrow(/flag/)
    expect(validateEntryParams({ ...valid, flag: '!' }).flag).toBe('!')
  })

  it('换行/控制字符拒绝', () => {
    expect(() => validateEntryParams({ ...valid, narration: 'a\nb' })).toThrow(/控制/)
    expect(() => validateEntryParams({ ...valid, payee: 'a\rb' })).toThrow(/控制/)
  })

  it('payee / narration 长度上限 200', () => {
    expect(() => validateEntryParams({ ...valid, payee: 'x'.repeat(201) })).toThrow(/长度/)
    expect(() => validateEntryParams({ ...valid, narration: 'x'.repeat(201) })).toThrow(/长度/)
    expect(validateEntryParams({ ...valid, payee: 'x'.repeat(200) }).payee).toHaveLength(200)
  })

  it('account 非法拒绝：空白 / 小写开头 / 无冒号 / 空串', () => {
    for (const account of ['Expenses Food', 'expenses:food', 'ExpensesFood', '', '1st:Bank']) {
      expect(() =>
        validateEntryParams({ ...valid, postings: [{ ...valid.postings[0], account }, ...valid.postings.slice(1)] })
      ).toThrow(/account/)
    }
  })

  it('金额格式拒绝', () => {
    for (const number of ['1e5', 'abc', '1,000', '', '1..2', '--5']) {
      expect(() =>
        validateEntryParams({ ...valid, postings: [{ ...valid.postings[0], number }, ...valid.postings.slice(1)] })
      ).toThrow(/number/)
    }
  })

  it('currency 非法拒绝：空白 / 空串 / 超长', () => {
    for (const currency of ['C N', '', 'X'.repeat(25)]) {
      expect(() =>
        validateEntryParams({ ...valid, postings: [{ ...valid.postings[0], currency }, ...valid.postings.slice(1)] })
      ).toThrow(/currency/)
    }
  })

  it('posting 数量边界：1 行拒绝 / 21 行拒绝 / 20 行通过', () => {
    expect(() => validateEntryParams({ ...valid, postings: [valid.postings[0]] })).toThrow(/postings/)
    expect(() =>
      validateEntryParams({ ...valid, postings: Array.from({ length: 21 }, () => valid.postings[0]) })
    ).toThrow(/postings/)
    expect(
      validateEntryParams({ ...valid, postings: Array.from({ length: 20 }, () => valid.postings[0]) })
    ).toBeTruthy()
  })

  it('非对象入参拒绝', () => {
    expect(() => validateEntryParams(null)).toThrow()
    expect(() => validateEntryParams('x')).toThrow()
    expect(() => validateEntryParams([])).toThrow()
  })
})
