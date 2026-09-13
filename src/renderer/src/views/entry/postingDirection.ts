/**
 * 双行录入「记账方向」判定（纯函数，单测覆盖）。
 *
 * 背景：表单固定两行、金额只填第一行（第二行自动取反）。若符号按行序硬编码（第一行 +、第二行 −），
 * 记「收入」时就会落成反的（Income 记正 = 收入减少），且行头「贷/付·资金减少」等标签会误导用户。
 * 故改为按账户类型定向，与 Excel 导入同一套约定（见 main/excel/import-builder.ts）：
 * - 支出行（Expenses）记正、收入行（Income）记负；
 * - 纯资产/负债/权益互转（转账）无类型线索，按行序：第一行转入（+）、第二行转出（−）。
 * 两行符号恒互为相反数 ⇒ 无论账户填在哪一行，落账方向都正确且恒平衡。
 */
import { accountType } from '../../../../shared/account'
import { negateDecimal } from '../../../../shared/decimal'

export type PostingSign = 1 | -1

/** 由两行账户推导各自记账符号（恒互为相反数）；缺账户/未知前缀退回「第一行 +、第二行 −」 */
export function resolvePostingSigns(account0?: string, account1?: string): [PostingSign, PostingSign] {
  const type0 = accountType((account0 ?? '').trim())
  const type1 = accountType((account1 ?? '').trim())
  // 收入在贷方（记负）、支出在借方（记正）——命中其一即整笔按该方向定符号
  if (type0 === 'Income' || type1 === 'Expenses') return [-1, 1]
  return [1, -1]
}

/** 单行记账语义短语（行头展示）：账户类型 + 记账符号 → 余额变动方向 */
export function postingEffectLabel(account: string | undefined, sign: PostingSign): string {
  const type = accountType((account ?? '').trim())
  if (type === 'Income') return sign < 0 ? '收入增加' : '收入减少'
  if (type === 'Expenses') return sign > 0 ? '支出增加' : '支出减少'
  if (type === 'Assets' || type === 'Liabilities' || type === 'Equity') {
    return sign > 0 ? '资金增加' : '资金减少'
  }
  return sign > 0 ? '记为正' : '记为负'
}

/** 落账金额：取输入绝对值后套用该行符号（'20' + sign -1 → '-20'）；空值原样 */
export function applyPostingSign(number: string, sign: PostingSign): string {
  const trimmed = number.trim()
  if (trimmed === '') return trimmed
  const magnitude = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed
  return sign < 0 ? negateDecimal(magnitude) : magnitude
}

/** 金额框展示：按该行符号呈现（符号只体现在显示上，表单存值仍是用户输入的数值） */
export function displaySignedNumber(value: string | number | undefined | null, sign: PostingSign): string {
  if (value === undefined || value === null) return ''
  const text = String(value)
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text
  const magnitude = text.startsWith('-') ? text.slice(1) : text
  if (/^0+(\.0+)?$/.test(magnitude)) return magnitude
  return sign < 0 ? `-${magnitude}` : magnitude
}

export interface EntryRow {
  account?: string
  number?: string | null
  currency?: string
}

export interface EntryPosting {
  account: string
  number: string
  currency: string
}

/** 表单两行 → 落账 postings：按账户类型定向金额符号，其余字段原样（非两行时不做定向） */
export function buildEntryPostings(rows: EntryRow[]): EntryPosting[] {
  const plain = (row: EntryRow): EntryPosting => ({
    account: row.account ?? '',
    number: (row.number ?? '').trim(),
    currency: row.currency ?? ''
  })
  if (rows.length !== 2) return rows.map(plain)
  const [sign0, sign1] = resolvePostingSigns(rows[0]?.account, rows[1]?.account)
  return rows.map((row, index) => ({
    ...plain(row),
    number: applyPostingSign(plain(row).number, index === 0 ? sign0 : sign1)
  }))
}
