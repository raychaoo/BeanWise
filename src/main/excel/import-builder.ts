/**
 * 通用 Excel 导入草稿生成（M10）：标准预览行 → 双行 Beancount 交易块 + 去重标记。
 * 借贷方向语义：支出 Expenses+/来源资产-，收入 资产+/Income-，中性按资产账户互转；标记两行：
 * - beanwise-import: <source>:<rowId>（同来源去重）
 * - beanwise-fp: <fingerprint>（跨来源去重，date|amount|counterparty|kind 哈希）
 */
import type { AddEntryParams, ExcelPreviewRow } from '../../shared/ipc'
import { negateDecimal } from '../../shared/decimal'
import { serializeEntry, serializeFirstEntryBlock } from '../entry-serializer'
import { fingerprintMarker } from '../dedup'
import { beanwiseMarker } from './parser'

export interface ExcelImportDraft {
  rowId: string
  source: string
  /** 跨来源去重指纹（date|amount|counterparty|kind 哈希） */
  fingerprint: string
  entry: AddEntryParams
  markerLine: string
  /** 首文件场景：open 行 + 交易块 + 标记 */
  block: string
  /** 追加场景：交易块 + 标记（open 由主进程统一补） */
  appendBlock: string
}

function textField(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '/' ? undefined : trimmed
}

/** 生成单笔导入草稿（纯函数，可单测）。 */
export function buildExcelImportDraft(row: ExcelPreviewRow, source: string, currency = 'CNY'): ExcelImportDraft {
  // 支出：Expenses +amount / 来源账户 -amount（Beancount 负债欠款为负，花呗消费 → 花呗 -amount 欠款增加）
  // 收入：来源账户 +amount / Income -amount
  // 中性：来源账户 +amount / 目标账户 -amount（提现/充值等资金转移）
  const postings =
    row.kind === 'expense'
      ? [
          { account: row.expenseAccount, number: row.amount, currency },
          { account: row.sourceAccount, number: negateDecimal(row.amount), currency }
        ]
      : row.kind === 'income'
        ? [
            { account: row.sourceAccount, number: row.amount, currency },
            { account: row.expenseAccount, number: negateDecimal(row.amount), currency }
          ]
        : [
            { account: row.expenseAccount, number: row.amount, currency },
            { account: row.sourceAccount, number: negateDecimal(row.amount), currency }
          ]
  const entry: AddEntryParams = {
    date: row.date,
    flag: '*',
    payee: textField(row.counterparty),
    narration: textField(row.product),
    postings
  }
  const marker = beanwiseMarker(source, row.rowId)
  const fpLine = row.fingerprint ? fingerprintMarker(row.fingerprint) : ''
  const markers = fpLine ? `${marker}\n${fpLine}` : marker
  return {
    rowId: row.rowId,
    source,
    fingerprint: row.fingerprint,
    entry,
    markerLine: marker,
    block: serializeFirstEntryBlock(entry) + markers + '\n',
    appendBlock: serializeEntry(entry) + markers + '\n'
  }
}
