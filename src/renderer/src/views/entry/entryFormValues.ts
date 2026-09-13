/**
 * 录入/编辑表单的纯数据映射：日期控件承载完整 YYYY-MM-DD HH:mm:ss，提交时拆成
 * Beancount 交易日期与交易级 time metadata；id/links 由编辑上下文透传，UI 不提供修改入口。
 */
import dayjs from 'dayjs'
import type { AddEntryParams } from '../../../../shared/ipc'
import { computeBalancingNumber } from '../../../../shared/decimal'
import { buildEntryPostings } from './postingDirection'

export interface PostingRow {
  account?: string
  number?: string | null
  currency?: string
  counterparty?: string
}

export interface EntryFormValues {
  date?: dayjs.Dayjs
  flag?: '*' | '!'
  payee?: string
  narration?: string
  postings: PostingRow[]
}

export interface EntryFormMeta {
  id?: string
  links?: string[]
  /** 编辑回填：金额已是账本中的最终符号，原样透传。 */
  preserveSigns?: boolean
}

/** 草稿 → 表单值：有 time 用秒级值；无 time 的当天数据取当前本地时间，历史数据取 00:00:00。 */
export function draftToFormValues(draft: AddEntryParams): EntryFormValues {
  const dateTime =
    draft.time ??
    (draft.date === dayjs().format('YYYY-MM-DD')
      ? `${draft.date} ${dayjs().format('HH:mm:ss')}`
      : `${draft.date} 00:00:00`)
  return {
    date: dayjs(dateTime),
    flag: draft.flag ?? '*',
    payee: draft.payee,
    narration: draft.narration,
    postings: draft.postings.map((p) => ({
      account: p.account,
      number: p.number,
      currency: p.currency,
      counterparty: p.counterparty
    }))
  }
}

/** 表单值 → IPC 入参；id/links 来自编辑上下文，确保稳定 ID 不被表单改写。 */
export function formValuesToEntryParams(values: EntryFormValues, meta: EntryFormMeta = {}): AddEntryParams {
  const dateTime = values.date ? dayjs(values.date) : dayjs()
  const date = dateTime.format('YYYY-MM-DD')
  const rows = (values.postings ?? []).filter((p) => p.account || p.number || p.currency)
  return {
    date,
    time: dateTime.format('YYYY-MM-DD HH:mm:ss'),
    ...(meta.id ? { id: meta.id } : {}),
    ...(values.flag ? { flag: values.flag } : {}),
    ...(values.payee?.trim() ? { payee: values.payee.trim() } : {}),
    ...(values.narration?.trim() ? { narration: values.narration.trim() } : {}),
    ...(meta.links && meta.links.length > 0 ? { links: meta.links } : {}),
    postings: buildEntryPostings(rows, { preserveSigns: meta.preserveSigns })
  }
}

/** 自动平衡决策（录入模式双行）：末行留空时返回前 n-1 行合计的相反数。 */
export function nextBalancingNumber(
  rows: Array<{ number?: string | null } | undefined> | undefined
): string | undefined {
  if (!rows || rows.length < 2) return undefined
  const lastIdx = rows.length - 1
  const last = rows[lastIdx]
  const lastVal = last?.number
  if (lastVal !== undefined && lastVal !== null && lastVal.trim() !== '') return undefined
  const amounts = rows
    .slice(0, lastIdx)
    .map((r) => r?.number?.trim())
    .filter((v): v is string => !!v)
  if (amounts.length === 0) return undefined
  try {
    return computeBalancingNumber(amounts)
  } catch {
    return undefined
  }
}
