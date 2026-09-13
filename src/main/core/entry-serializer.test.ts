import { describe, expect, it } from 'vitest'
import type { AddEntryParams } from '../../shared/ipc'
import { ensureEntryMetadata, findUnopenedAccounts, replaceEntryById, serializeEntry, serializeFirstEntryBlock, serializeOpenLines, serializeOptionsHeader, validateEntryParams } from './entry-serializer'

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

  it('counterparty：posting 级 metadata，缩进 4 格，只挂在带对象的分录下（ADR 23）', () => {
    expect(
      serializeEntry({
        ...valid,
        postings: [
          { account: 'Assets:Receivables:Lend', number: '5000.00', currency: 'CNY', counterparty: '李志全' },
          { account: 'Assets:Bank:ZSYH', number: '-5000.00', currency: 'CNY' }
        ]
      })
    ).toBe(
      '2026-08-09 * "测试午饭" "M4 E2E"\n' +
        '  Assets:Receivables:Lend  5000.00 CNY\n' +
        '    counterparty: "李志全"\n' +
        '  Assets:Bank:ZSYH  -5000.00 CNY\n'
    )
  })

  it('反斜杠转义：beancount 用 C 风格转义（`\\b` = 退格符），字面反斜杠须写成两个', () => {
    expect(serializeEntry({ ...valid, payee: 'a\\b' })).toMatch(/^2026-08-09 \* "a\\\\b"/)
    expect(
      serializeEntry({
        ...valid,
        postings: [
          { account: 'Assets:Receivables:Lend', number: '1', currency: 'CNY', counterparty: 'x\\y' },
          { account: 'Assets:Bank:ZSYH', number: '-1', currency: 'CNY' }
        ]
      })
    ).toContain('    counterparty: "x\\\\y"\n')
  })

  it('links：交易级 ^link，追加在 payee/narration 之后（ADR 23 P2）', () => {
    expect(serializeEntry({ ...valid, links: ['lend-abc', 'lend-def'] })).toBe(
      '2026-08-09 * "测试午饭" "M4 E2E" ^lend-abc ^lend-def\n' +
        '  Expenses:Food  25.50 CNY\n' +
        '  Assets:Cash  -25.50 CNY\n'
    )
    // 无 payee/narration 分支同样成立（link 跟在标志之后）
    expect(serializeEntry({ ...valid, payee: undefined, narration: undefined, links: ['lend-x'] })).toBe(
      '2026-08-09 * ^lend-x\n  Expenses:Food  25.50 CNY\n  Assets:Cash  -25.50 CNY\n'
    )
  })

  it('id/time：交易级 metadata，写在标题之后、posting 之前', () => {
    expect(
      serializeEntry({
        ...valid,
        id: 'bw-0123456789abcdef',
        time: '2026-08-09 08:30:15'
      } as AddEntryParams)
    ).toBe(
      '2026-08-09 * "测试午饭" "M4 E2E"\n' +
        '  id: "bw-0123456789abcdef"\n' +
        '  time: "2026-08-09 08:30:15"\n' +
        '  Expenses:Food  25.50 CNY\n' +
        '  Assets:Cash  -25.50 CNY\n'
    )
  })
})

describe('ensureEntryMetadata', () => {
  it('已有 id/time 原样保留', () => {
    const params: AddEntryParams = {
      ...valid,
      id: 'bw-existing',
      time: '2026-08-09 12:34:56'
    }
    expect(ensureEntryMetadata(params, new Date(2026, 7, 9, 18, 0, 0))).toEqual(params)
  })

  it('缺省时生成稳定格式 ID；当天交易取当前本地秒级时间，历史日期取 00:00:00', () => {
    const current = ensureEntryMetadata(valid, new Date(2026, 7, 9, 12, 34, 56))
    expect(current.id).toMatch(/^bw-[0-9a-f-]{36}$/)
    expect(current.time).toBe('2026-08-09 12:34:56')

    const historical = ensureEntryMetadata({ ...valid, date: '2026-01-02' }, new Date(2026, 7, 9, 12, 34, 56))
    expect(historical.id).toMatch(/^bw-[0-9a-f-]{36}$/)
    expect(historical.time).toBe('2026-01-02 00:00:00')
  })
})

describe('replaceEntryById', () => {
  const ledger =
    'option "title" "T"\n\n' +
    '2026-01-01 * "A" "first"\n' +
    '  id: "bw-a"\n' +
    '  time: "2026-01-01 08:00:00"\n' +
    '  Expenses:Food  10.00 CNY\n' +
    '  Assets:Cash  -10.00 CNY\n' +
    '\n' +
    '2026-01-02 * "B" "second"\n' +
    '  Expenses:Food  20.00 CNY\n' +
    '  Assets:Cash  -20.00 CNY\n'

  it('只替换指定 ID 的交易块，保留其它内容与空行', () => {
    const replacement = serializeEntry({
      date: '2026-01-01',
      id: 'bw-a',
      time: '2026-01-01 09:30:00',
      payee: 'A',
      narration: 'edited',
      postings: [
        { account: 'Expenses:Food', number: '11.00', currency: 'CNY' },
        { account: 'Assets:Cash', number: '-11.00', currency: 'CNY' }
      ]
    })
    const updated = replaceEntryById(ledger, 'bw-a', replacement)
    expect(updated).toContain('  time: "2026-01-01 09:30:00"')
    expect(updated).toContain('  Expenses:Food  11.00 CNY')
    expect(updated).toContain('2026-01-02 * "B" "second"')
    expect(updated.match(/2026-01-01 \* "A"/g)).toHaveLength(1)
  })

  it('ID 不存在或重复 → 明确拒绝', () => {
    expect(() => replaceEntryById(ledger, 'bw-missing', 'x\n')).toThrow(/未找到/)
    expect(() => replaceEntryById(ledger + ledger, 'bw-a', 'x\n')).toThrow(/重复/)
  })
})

describe('findUnopenedAccounts / serializeOpenLines（追加场景补 open 行）', () => {
  const ledger = [
    '2026-01-01 open Assets:Cash',
    '2026-01-01 open Expenses:Food',
    '',
    '2026-06-01 * "午餐"',
    '  Expenses:Food  25.00 CNY',
    '  Assets:Cash  -25.00 CNY',
    ''
  ].join('\n')

  it('已 open 的账户不返回；未 open 的按顺序去重', () => {
    expect(findUnopenedAccounts(ledger, ['Assets:Cash', 'Equity:AutoBalance', 'Assets:Cash']))
      .toEqual(['Equity:AutoBalance'])
  })

  it('全部已 open → 空数组 + 空 open 行前缀', () => {
    expect(findUnopenedAccounts(ledger, ['Assets:Cash'])).toEqual([])
    expect(serializeOpenLines('2026-08-09', [])).toBe('')
  })

  it('serializeOpenLines 输出 open 行前缀', () => {
    expect(serializeOpenLines('2026-08-09', ['Equity:AutoBalance']))
      .toBe('2026-08-09 open Equity:AutoBalance\n')
  })
})

describe('serializeOptionsHeader（新建账本 options 头）', () => {
  it('title + operating_currency，含末尾空行', () => {
    expect(serializeOptionsHeader('CNY')).toBe(
      'option "title" "BeanWise"\noption "operating_currency" "CNY"\n\n'
    )
  })
})

describe('serializeFirstEntryBlock（首文件：options 头 + open 行 + 交易块）', () => {
  it('输出快照：options 头 + open 行按 posting 顺序 + 交易块', () => {
    expect(serializeFirstEntryBlock(valid)).toBe(
      'option "title" "BeanWise"\n' +
        'option "operating_currency" "CNY"\n' +
        '\n' +
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

  it('全部为收支账户拒绝（餐饮 + 购物场景）', () => {
    expect(() =>
      validateEntryParams({
        ...valid,
        postings: [
          { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
          { account: 'Expenses:Shopping', number: '-25.50', currency: 'CNY' }
        ]
      })
    ).toThrow('交易不能全部为收支账户')
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

  it('posting.counterparty：trim 归一 / 超长拒绝 / 控制字符拒绝 / 空串与缺省等价（ADR 23）', () => {
    const withCp = (counterparty: unknown): unknown => ({
      ...valid,
      postings: [
        { account: 'Assets:Receivables:Lend', number: '1', currency: 'CNY', counterparty },
        { account: 'Assets:Bank:ZSYH', number: '-1', currency: 'CNY' }
      ]
    })
    expect(validateEntryParams(withCp('  李志全  ')).postings[0]!.counterparty).toBe('李志全')
    expect(validateEntryParams(withCp('')).postings[0]!.counterparty).toBeUndefined()
    expect(validateEntryParams(withCp(undefined)).postings[0]!.counterparty).toBeUndefined()
    expect(() => validateEntryParams(withCp('x'.repeat(201)))).toThrow(/counterparty/)
    expect(() => validateEntryParams(withCp('a\nb'))).toThrow(/counterparty/)
    expect(() => validateEntryParams(withCp(123))).toThrow(/counterparty/)
  })

  it('links 校验：非法字符 / 重复 / 超量 / 非数组一律拒绝；空数组归缺省（ADR 23 P2）', () => {
    const withLinks = (links: unknown): unknown => ({ ...valid, links })
    expect(validateEntryParams(withLinks(['lend-abc'])).links).toEqual(['lend-abc'])
    expect(validateEntryParams(withLinks([])).links).toBeUndefined()
    // 中文 / 点 / 斜杠 / 空格：beancount link 词法不吃，必须在入参防线拦掉
    expect(() => validateEntryParams(withLinks(['lend中文']))).toThrow(/link 非法/)
    expect(() => validateEntryParams(withLinks(['lend.a']))).toThrow(/link 非法/)
    expect(() => validateEntryParams(withLinks(['lend/a']))).toThrow(/link 非法/)
    expect(() => validateEntryParams(withLinks(['a b']))).toThrow(/link 非法/)
    expect(() => validateEntryParams(withLinks(['a', 'a']))).toThrow(/重复/)
    expect(() => validateEntryParams(withLinks(Array.from({ length: 21 }, (_, i) => `l${i}`)))).toThrow(/最多/)
    expect(() => validateEntryParams(withLinks('lend-a'))).toThrow(/必须为数组/)
    expect(() => validateEntryParams(withLinks(['x'.repeat(65)]))).toThrow(/长度/)
  })

  it('id/time 校验：ID 仅 ASCII 安全字符，时间必须为同日 YYYY-MM-DD HH:mm:ss', () => {
    expect(validateEntryParams({ ...valid, id: 'bw-abc_123', time: '2026-08-09 08:30:15' })).toMatchObject({
      id: 'bw-abc_123',
      time: '2026-08-09 08:30:15'
    })
    for (const id of ['中文', 'a b', 'a/b', 'x'.repeat(65)]) {
      expect(() => validateEntryParams({ ...valid, id })).toThrow(/id/)
    }
    for (const time of ['2026-08-09', '2026-08-09 8:30:15', '2026-08-10 08:30:15']) {
      expect(() => validateEntryParams({ ...valid, time })).toThrow(/time/)
    }
  })

  it('posting 数量边界：1 行拒绝 / 21 行拒绝 / 20 行通过', () => {
    expect(() => validateEntryParams({ ...valid, postings: [valid.postings[0]] })).toThrow(/postings/)
    expect(() =>
      validateEntryParams({ ...valid, postings: Array.from({ length: 21 }, () => valid.postings[0]) })
    ).toThrow(/postings/)
    expect(
      validateEntryParams({
        ...valid,
        postings: [
          ...Array.from({ length: 19 }, () => valid.postings[0]),
          valid.postings[1]
        ]
      })
    ).toBeTruthy()
  })

  it('非对象入参拒绝', () => {
    expect(() => validateEntryParams(null)).toThrow()
    expect(() => validateEntryParams('x')).toThrow()
    expect(() => validateEntryParams([])).toThrow()
  })
})
