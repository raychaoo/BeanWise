import { describe, expect, it } from 'vitest'
import type { ExcelPreviewRow } from '../../shared/ipc'
import { buildExcelImportDraft } from './import-builder'

describe('buildExcelImportDraft（Excel 行 → Beancount 文本）', () => {
  const row: ExcelPreviewRow = {
    rowNumber: 2,
    date: '2026-08-21',
    time: '16:09:20',
    transactionType: '商户消费',
    counterparty: '麦当劳',
    product: '麦当劳',
    kind: 'expense',
    amount: '17.4',
    paymentMethod: '招商银行储蓄卡(8888)',
    status: '支付成功',
    rowId: 'A1',
    alreadyImported: false,
    fingerprint: '5dafb0225fbfc5fc',
    dupState: 'none',
    expenseAccount: 'Expenses:Shopping',
    sourceAccount: 'Assets:Bank:CCB'
  }

  it('支出行：Expenses + / 来源 -，附 beanwise-import 标记', () => {
    const draft = buildExcelImportDraft(row, 'cmb')
    expect(draft.entry.postings).toEqual([
      { account: 'Expenses:Shopping', number: '17.4', currency: 'CNY' },
      { account: 'Assets:Bank:CCB', number: '-17.4', currency: 'CNY' }
    ])
    expect(draft.appendBlock).toBe(
      '2026-08-21 * "麦当劳" "麦当劳"\n' +
        '  Expenses:Shopping  17.4 CNY\n' +
        '  Assets:Bank:CCB  -17.4 CNY\n' +
        '; beanwise-import: cmb:A1\n' +
        '; beanwise-fp: 5dafb0225fbfc5fc\n'
    )
  })

  it('收入行：来源资产 + / Income -', () => {
    const draft = buildExcelImportDraft({ ...row, kind: 'income', expenseAccount: 'Income:Transfer', counterparty: '杜永奇' }, 'cmb')
    expect(draft.entry.postings).toEqual([
      { account: 'Assets:Bank:CCB', number: '17.4', currency: 'CNY' },
      { account: 'Income:Transfer', number: '-17.4', currency: 'CNY' }
    ])
  })

  it('中性行：来源资产 + / 目标资产 -', () => {
    const draft = buildExcelImportDraft({ ...row, kind: 'neutral', expenseAccount: 'Assets:WeChat', sourceAccount: 'Assets:Bank:CCB' }, 'cmb')
    expect(draft.entry.postings).toEqual([
      { account: 'Assets:WeChat', number: '17.4', currency: 'CNY' },
      { account: 'Assets:Bank:CCB', number: '-17.4', currency: 'CNY' }
    ])
  })

  it('花呗消费：Expenses + / 负债 -（Beancount 欠款为负，负债增加）', () => {
    const draft = buildExcelImportDraft(
      { ...row, sourceAccount: 'Liabilities:Alipay:Huabei' },
      'cmb'
    )
    expect(draft.entry.postings).toEqual([
      { account: 'Expenses:Shopping', number: '17.4', currency: 'CNY' },
      { account: 'Liabilities:Alipay:Huabei', number: '-17.4', currency: 'CNY' }
    ])
  })

  it('退款到花呗（收入）：负债 + / Income -（欠款减少）', () => {
    const draft = buildExcelImportDraft(
      { ...row, kind: 'income', sourceAccount: 'Liabilities:Alipay:Huabei', expenseAccount: 'Income:Refund' },
      'cmb'
    )
    expect(draft.entry.postings).toEqual([
      { account: 'Liabilities:Alipay:Huabei', number: '17.4', currency: 'CNY' },
      { account: 'Income:Refund', number: '-17.4', currency: 'CNY' }
    ])
  })

  it('还花呗（中性）：负债 + / 资产 -（欠款减少）', () => {
    const draft = buildExcelImportDraft(
      { ...row, kind: 'neutral', expenseAccount: 'Liabilities:Alipay:Huabei', sourceAccount: 'Assets:Bank:ZSYH' },
      'cmb'
    )
    expect(draft.entry.postings).toEqual([
      { account: 'Liabilities:Alipay:Huabei', number: '17.4', currency: 'CNY' },
      { account: 'Assets:Bank:ZSYH', number: '-17.4', currency: 'CNY' }
    ])
  })

  it('空对方/商品省略；自定义货币', () => {
    const draft = buildExcelImportDraft({ ...row, counterparty: '', product: '/' }, 'cmb', 'HKD')
    expect(draft.entry.payee).toBeUndefined()
    expect(draft.entry.narration).toBeUndefined()
    expect(draft.appendBlock.startsWith('2026-08-21 *\n')).toBe(true)
    expect(draft.appendBlock).toContain('17.4 HKD')
    expect(draft.appendBlock).toContain('-17.4 HKD')
  })
})
