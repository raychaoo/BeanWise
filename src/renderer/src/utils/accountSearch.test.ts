/**
 * 科目搜索匹配：账户页「科目管理」（名称/用途 + 路径两条检索线）与对账页
 * 「科目余额表」（单框命中中文名或路径）两处共用同一套口径，此处逐条钉死。
 */
import { describe, expect, it } from 'vitest'
import type { AccountEntry } from '../../../shared/ipc'
import { includesQuery, matchesAccountLabel, matchesAccountSearch, normalizeQuery } from './accountSearch'

type Entry = Pick<AccountEntry, 'name' | 'description' | 'value'>

function acc(name: string, value: string, description?: string): Entry {
  return { name, value, description }
}

const bank = acc('招商银行', 'Assets:Bank:CMB', '工资卡')
const food = acc('吃饭', 'Expenses:Food', '日常餐饮')

describe('normalizeQuery（检索词归一）', () => {
  it('去首尾空白 + 小写', () => {
    expect(normalizeQuery('  Bank  ')).toBe('bank')
    expect(normalizeQuery('招商')).toBe('招商') // 中文无大小写，原样保留
    expect(normalizeQuery('   ')).toBe('')
  })
})

describe('includesQuery（大小写不敏感子串，空串不约束）', () => {
  it('空检索词恒命中（含 null/undefined 文本）', () => {
    expect(includesQuery('任意', '')).toBe(true)
    expect(includesQuery(null, '')).toBe(true)
    expect(includesQuery(undefined, '')).toBe(true)
  })

  it('检索词内部归一：传输入框原值即可（含首尾空白）', () => {
    expect(includesQuery('Assets:Bank:CMB', 'bank:cmb')).toBe(true)
    expect(includesQuery('Assets:Bank:CMB', 'Assets')).toBe(true)
    expect(includesQuery('Assets:Bank:CMB', ' BANK ')).toBe(true)
  })

  it('缺文本不命中非空检索词；不匹配则 false', () => {
    expect(includesQuery(undefined, 'x')).toBe(false)
    expect(includesQuery('Assets:Bank:CMB', 'bank:cnb')).toBe(false)
  })
})

describe('matchesAccountSearch（科目管理：名称/用途 + 路径两条线 AND）', () => {
  it('两框皆空 → 全部命中', () => {
    expect(matchesAccountSearch(bank, '', '')).toBe(true)
    expect(matchesAccountSearch(bank, '  ', '  ')).toBe(true)
  })

  it('名称线：命中中文名称或用途', () => {
    expect(matchesAccountSearch(bank, '招商', '')).toBe(true)
    expect(matchesAccountSearch(bank, '工资卡', '')).toBe(true) // 用途
    expect(matchesAccountSearch(bank, '吃饭', '')).toBe(false)
    expect(matchesAccountSearch(food, '餐饮', '')).toBe(true) // 用途
  })

  it('路径线：大小写不敏感', () => {
    expect(matchesAccountSearch(bank, '', 'assets:bank')).toBe(true)
    expect(matchesAccountSearch(bank, '', 'Expenses')).toBe(false)
    expect(matchesAccountSearch(food, '', 'food')).toBe(true)
  })

  it('两条线 AND 叠加：各自单独命中、合起来不命中 → false', () => {
    expect(matchesAccountSearch(bank, '招商', 'Assets')).toBe(true)
    expect(matchesAccountSearch(bank, '招商', 'Expenses')).toBe(false)
    expect(matchesAccountSearch(bank, '吃饭', 'Assets')).toBe(false)
  })

  it('用途缺省（undefined）不影响路径线判定', () => {
    const noDesc = acc('现金', 'Assets:Cash')
    expect(matchesAccountSearch(noDesc, '现金', '')).toBe(true)
    expect(matchesAccountSearch(noDesc, '', 'Cash')).toBe(true)
    expect(matchesAccountSearch(noDesc, '餐饮', '')).toBe(false)
  })
})

describe('matchesAccountLabel（科目余额表单框：中文名或路径任一命中）', () => {
  it('空检索词恒命中', () => {
    expect(matchesAccountLabel('招商银行', 'Assets:Bank:CMB', '')).toBe(true)
    expect(matchesAccountLabel('招商银行', 'Assets:Bank:CMB', '  ')).toBe(true)
  })

  it('中文名与原始路径任一命中即可（有账户库配置时 label ≠ path）', () => {
    expect(matchesAccountLabel('招商银行', 'Assets:Bank:CMB', '招商')).toBe(true)
    expect(matchesAccountLabel('招商银行', 'Assets:Bank:CMB', 'bank:cmb')).toBe(true)
    expect(matchesAccountLabel('招商银行', 'Assets:Bank:CMB', 'Food')).toBe(false)
  })

  it('无账户库配置时 label === 路径，单条判定不重复', () => {
    expect(matchesAccountLabel('Expenses:Food', 'Expenses:Food', 'food')).toBe(true)
  })
})
