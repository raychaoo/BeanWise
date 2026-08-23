import { describe, expect, it, vi } from 'vitest'
import type { ExcelImportTemplate } from '../../shared/ipc'
import { defaultAccountMapping } from './account-mapping'
import {
  excelAccountDescription,
  excelAccountLabel,
  syncExcelAccountsToConfig,
  type ExcelAccountStore
} from './account-label'

function makeTemplate(name = '招商银行信用卡'): ExcelImportTemplate {
  return {
    id: 'cmb-credit',
    name,
    source: 'cmb-credit',
    fieldMapping: {
      dateColumn: '交易时间',
      amountColumn: '金额',
      ioColumn: '收/支',
      typeColumn: '交易类型',
      counterpartyColumn: '交易对方',
      productColumn: '商品',
      methodColumn: '支付方式',
      rowIdColumn: '交易单号'
    },
    directionRule: { mode: 'column', positiveAs: 'income' },
    accountMapping: defaultAccountMapping()
  }
}

describe('excelAccountLabel（中文显示名）', () => {
  const template = makeTemplate()

  it('支出/收入/来源账户从模板映射反查中文名', () => {
    expect(excelAccountLabel('Expenses:Transfer', template)).toBe('转账')
    expect(excelAccountLabel('Income:Refund', template)).toBe('美团平台商户-退款')
    expect(excelAccountLabel('Assets:Bank:ZSYH', template)).toBe('招商银行储蓄卡(6156)')
    expect(excelAccountLabel('Assets:WeChat:Pay', template)).toBe('微信余额') // 零钱 → 微信余额-资产
    expect(excelAccountLabel('Assets:WeChat', template)).toBe('未分类资产') // 兜底
    expect(excelAccountLabel('Expenses:Uncategorized', template)).toBe('其他支出')
  })

  it('未知账户用中文路径兜底，不回退纯英文路径', () => {
    expect(excelAccountLabel('Assets:Bank:ICBC', template)).toBe('资产·银行·工商银行')
    expect(excelAccountLabel('Assets:Foo', template)).toBe('资产·Foo')
  })
})

describe('excelAccountDescription（用途描述）', () => {
  const template = makeTemplate()

  it('按账户角色生成描述并带模板名', () => {
    expect(excelAccountDescription('Expenses:Transfer', template)).toBe('支出科目 · 招商银行信用卡')
    expect(excelAccountDescription('Income:Refund', template)).toBe('收入科目 · 招商银行信用卡')
    expect(excelAccountDescription('Assets:Bank:ZSYH', template)).toBe('支付渠道来源账户 · 招商银行信用卡')
    expect(excelAccountDescription('Assets:WeChat:Pay', template)).toBe('支付渠道来源账户 · 招商银行信用卡')
    expect(excelAccountDescription('Assets:WeChat', template)).toBe('未分类资产兜底 · 招商银行信用卡')
  })

  it('模板名为空时回退「Excel 流水」', () => {
    expect(excelAccountDescription('Assets:Bank:ZSYH', makeTemplate(''))).toBe('支付渠道来源账户 · Excel 流水')
  })
})

describe('syncExcelAccountsToConfig（同步当前工作目录账户库）', () => {
  it('只补缺失账户，中文名 + 用途描述，不覆盖已有账户', () => {
    const saved: Array<{ id: number; name: string; value: string; description?: string }> = []
    const store: ExcelAccountStore = {
      load: () => [{ id: 1, name: '购物', value: 'Expenses:Shopping', description: '手工维护' }],
      save: (accounts) => saved.push(...accounts),
      nextId: () => 2
    }
    const additions = syncExcelAccountsToConfig(
      ['Expenses:Shopping', 'Assets:Bank:ZSYH', 'Assets:Bank:ICBC'],
      makeTemplate(),
      store
    )
    expect(additions).toHaveLength(2)
    expect(saved.find((a) => a.value === 'Expenses:Shopping')).toEqual(
      expect.objectContaining({ name: '购物', description: '手工维护' })
    )
    expect(saved.find((a) => a.value === 'Assets:Bank:ZSYH')).toEqual(
      expect.objectContaining({ id: 2, name: '招商银行储蓄卡(6156)', description: '支付渠道来源账户 · 招商银行信用卡' })
    )
    expect(saved.find((a) => a.value === 'Assets:Bank:ICBC')).toEqual(
      expect.objectContaining({ name: '资产·银行·工商银行', description: '流水导入 · 招商银行信用卡' })
    )
  })

  it('全部已存在时不写库', () => {
    const save = vi.fn()
    const store: ExcelAccountStore = {
      load: () => [{ id: 1, name: '招商银行储蓄卡(6156)', value: 'Assets:Bank:CCB', description: '' }],
      save,
      nextId: () => 2
    }
    expect(syncExcelAccountsToConfig(['Assets:Bank:CCB'], makeTemplate(), store)).toEqual([])
    expect(save).not.toHaveBeenCalled()
  })
})
