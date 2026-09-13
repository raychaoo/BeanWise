/**
 * 录入交易序列化（M4 定稿，纯函数）：
 * validateEntryParams 前置校验（非法 throw 中文 Error）→ serializeEntry 输出 beancount 文本块。
 * 文本块以 \n 结尾、不含前导空行；金额原样十进制字符串，不做对齐美化。
 * beancount 语义：单字符串归 payee，双字符串为 payee + narration（与 M3 fixture 解析一致）。
 */
import { randomUUID } from 'node:crypto'
import type { AddEntryParams, AddEntryPosting } from '../../shared/ipc'
import { isAllPnlAccounts } from '../../shared/account'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const FLAGS = ['*', '!'] as const
const MAX_TEXT_LEN = 200
const MAX_CURRENCY_LEN = 24
const MIN_POSTINGS = 2
const MAX_POSTINGS = 20
const DECIMAL_RE = /^-?\d+(\.\d+)?$/
/** 交易级 link（ADR 23 P2 核销）：beancount link 词法受限，只放行 ASCII 字母数字下划线连字符
 * （实测中文/点/斜杠均报 Invalid token，不靠生成端自律、直接在入参防线拦掉） */
const LINK_RE = /^[A-Za-z0-9_-]+$/
const MAX_LINKS = 20
const MAX_LINK_LEN = 64
const CONTROL_RE = /[\u0000-\u001F\u007F]/
const ENTRY_ID_RE = /^[A-Za-z0-9_-]+$/
const MAX_ENTRY_ID_LEN = 64
const ENTRY_TIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const TRANSACTION_HEADER_RE = /^\d{4}-\d{2}-\d{2}\s+[*!](?:\s|$)/
const TRANSACTION_ID_META_RE = /^\s+id:\s*"([A-Za-z0-9_-]+)"\s*$/

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function assertDate(date: unknown): asserts date is string {
  if (typeof date !== 'string') throw new Error('date 必须为字符串')
  const m = DATE_RE.exec(date)
  if (!m) throw new Error('日期必须为 YYYY-MM-DD 格式')
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`日期非法: ${date}`)
  }
}

/** 文本字段校验：trim、长度上限、禁控制字符；空串归缺省 */
function assertText(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} 必须为字符串`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_TEXT_LEN) throw new Error(`${name} 长度不能超过 ${MAX_TEXT_LEN} 字符`)
  if (CONTROL_RE.test(trimmed)) throw new Error(`${name} 不能包含换行/控制字符`)
  return trimmed === '' ? undefined : trimmed
}

function assertPosting(raw: unknown): AddEntryPosting {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('posting 必须为对象')
  }
  const p = raw as Record<string, unknown>

  if (typeof p.account !== 'string' || p.account === '' || /\s/.test(p.account) || !p.account.includes(':') || !/^[A-Z]/.test(p.account)) {
    throw new Error(`account 非法: ${JSON.stringify(p.account)}`)
  }

  if (typeof p.number !== 'string' || !DECIMAL_RE.test(p.number)) {
    throw new Error(`number 必须为十进制金额字符串: ${JSON.stringify(p.number)}`)
  }

  if (typeof p.currency !== 'string' || p.currency === '' || /\s/.test(p.currency) || p.currency.length > MAX_CURRENCY_LEN) {
    throw new Error(`currency 非法: ${JSON.stringify(p.currency)}`)
  }

  // 往来对象（ADR 23）：可选，与 payee/narration 同口径（trim / 长度上限 / 禁控制字符）
  const counterparty = assertText('counterparty', p.counterparty)

  return {
    account: p.account,
    number: p.number,
    currency: p.currency,
    ...(counterparty !== undefined ? { counterparty } : {})
  }
}

/**
 * 入参类型与范围校验（IPC 入参防线之一，见 CLAUDE.md 约束 #6）。
 * 非法 throw 中文 Error（invoke reject，UI 直接展示）。
 */
export function validateEntryParams(raw: unknown): AddEntryParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('入参必须为对象')
  }
  const obj = raw as Record<string, unknown>

  assertDate(obj.date)

  if (obj.flag !== undefined && !FLAGS.includes(obj.flag as never)) {
    throw new Error('flag 必须是 * 或 !')
  }

  const payee = assertText('payee', obj.payee)
  const narration = assertText('narration', obj.narration)

  let id: string | undefined
  if (obj.id !== undefined) {
    if (typeof obj.id !== 'string' || !ENTRY_ID_RE.test(obj.id)) {
      throw new Error(`id 非法（仅允许字母数字下划线连字符）: ${JSON.stringify(obj.id)}`)
    }
    if (obj.id.length > MAX_ENTRY_ID_LEN) throw new Error(`id 长度不能超过 ${MAX_ENTRY_ID_LEN} 字符`)
    id = obj.id
  }

  let time: string | undefined
  if (obj.time !== undefined) {
    if (typeof obj.time !== 'string') throw new Error('time 必须为 YYYY-MM-DD HH:mm:ss 格式')
    const match = ENTRY_TIME_RE.exec(obj.time)
    if (!match) throw new Error('time 必须为 YYYY-MM-DD HH:mm:ss 格式')
    const [, timeDate, hour, minute, second] = match
    if (timeDate !== obj.date) throw new Error('time 的日期必须与交易日期一致')
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
      throw new Error(`time 非法: ${obj.time}`)
    }
    time = obj.time
  }

  let links: string[] | undefined
  if (obj.links !== undefined) {
    if (!Array.isArray(obj.links)) throw new Error('links 必须为数组')
    if (obj.links.length > MAX_LINKS) throw new Error(`links 最多 ${MAX_LINKS} 个`)
    const seen = new Set<string>()
    for (const raw of obj.links) {
      if (typeof raw !== 'string' || !LINK_RE.test(raw)) {
        throw new Error(`link 非法（仅允许字母数字下划线连字符）: ${JSON.stringify(raw)}`)
      }
      if (raw.length > MAX_LINK_LEN) throw new Error(`link 长度不能超过 ${MAX_LINK_LEN} 字符`)
      if (seen.has(raw)) throw new Error(`link 重复: ${raw}`)
      seen.add(raw)
    }
    links = obj.links as string[]
  }

  if (!Array.isArray(obj.postings)) throw new Error('postings 必须为数组')
  if (obj.postings.length < MIN_POSTINGS || obj.postings.length > MAX_POSTINGS) {
    throw new Error(`postings 必须为 ${MIN_POSTINGS}~${MAX_POSTINGS} 行`)
  }
  const postings = obj.postings.map(assertPosting)
  if (isAllPnlAccounts(postings.map((p) => p.account))) {
    throw new Error('交易不能全部为收支账户，至少一个账户应为资产/负债/权益账户')
  }

  return {
    date: obj.date,
    ...(id !== undefined ? { id } : {}),
    ...(time !== undefined ? { time } : {}),
    ...(obj.flag !== undefined ? { flag: obj.flag as '*' | '!' } : {}),
    ...(payee !== undefined ? { payee } : {}),
    ...(narration !== undefined ? { narration } : {}),
    ...(links !== undefined && links.length > 0 ? { links } : {}),
    postings
  }
}

/** 补齐稳定交易 ID 与秒级时间。当天录入取当前本地时间；历史日期缺省取 00:00:00。 */
export function ensureEntryMetadata(params: AddEntryParams, now = new Date()): AddEntryParams {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return {
    ...params,
    id: params.id ?? `bw-${randomUUID()}`,
    time: params.time ?? `${params.date} ${params.date === date ? time : '00:00:00'}`
  }
}

/** 按交易级 `id` metadata 替换一整笔交易；找不到或重复 ID 一律拒绝。 */
function findEntryBlockById(lines: string[], id: string): { start: number; end: number } {
  const matches: Array<{ start: number; end: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!TRANSACTION_HEADER_RE.test(lines[i]!)) continue
    let end = i + 1
    while (end < lines.length && lines[end]!.trim() !== '' && /^\s/.test(lines[end]!)) end++
    let foundId: string | null = null
    for (let j = i + 1; j < end; j++) {
      const match = TRANSACTION_ID_META_RE.exec(lines[j]!)
      if (match) {
        foundId = match[1]!
        break
      }
    }
    if (foundId === id) matches.push({ start: i, end })
  }
  if (matches.length === 0) throw new Error(`未找到交易 ID: ${id}`)
  if (matches.length > 1) throw new Error(`交易 ID 重复: ${id}`)
  return matches[0]!
}

/** 按交易级 `id` metadata 替换一整笔交易；找不到或重复 ID 一律拒绝。 */
export function replaceEntryById(content: string, id: string, replacement: string): string {
  const lines = content.split('\n')
  const { start, end } = findEntryBlockById(lines, id)
  const replacementLines = replacement.replace(/\n$/, '').split('\n')
  return [...lines.slice(0, start), ...replacementLines, ...lines.slice(end)].join('\n')
}

/**
 * 编辑单笔交易前保证分录账户在交易日期可用：
 * - 已有 open 且日期晚于交易 → 前移到交易日期（open 早开不影响余额）；
 * - 尚未 open → 在目标交易前补 open 行。
 * 这样把历史交易改分类到后来才首次使用的账户时，不会触发 Beancount
 * `Invalid reference to inactive account`。
 */
export function ensureEntryAccountsOpen(content: string, id: string, date: string, accounts: string[]): string {
  const uniqueAccounts = [...new Set(accounts)]
  if (uniqueAccounts.length === 0) return content

  const lines = content.split('\n')
  const { start } = findEntryBlockById(lines, id)
  const accountSet = new Set(uniqueAccounts)
  const found = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const match = /^(\d{4}-\d{2}-\d{2})(\s+open\s+)(\S+)(.*?)(\r?)$/.exec(lines[i]!)
    if (!match) continue
    const openDate = match[1]!
    const account = match[3]!
    if (!accountSet.has(account)) continue
    found.add(account)
    if (openDate > date) {
      lines[i] = `${date}${match[2]}${account}${match[4]}${match[5]}`
    }
  }

  const missing = uniqueAccounts.filter((account) => !found.has(account))
  if (missing.length === 0) return lines.join('\n')
  const eol = lines[start]!.endsWith('\r') ? '\r' : ''
  const openLines = missing.map((account) => `${date} open ${account}${eol}`)
  return [...lines.slice(0, start), ...openLines, ...lines.slice(start)].join('\n')
}

/**
 * 序列化为 beancount 文本块（以 \n 结尾、无前导空行）。
 * 前提：入参已经 validateEntryParams 校验（control char 已被拒收）。
 * 带 counterparty 的分录追加一行 posting 级 metadata（缩进 4 格，必须多于分录行的 2 格）。
 */
export function serializeEntry(params: AddEntryParams): string {
  const flag = params.flag ?? '*'
  // beancount 字符串用 C 风格转义（实测：`\b` 被解析为退格符），故反斜杠必须先转义，
  // 否则 payee 里的 `\` 会静默写坏（2026-09-13 实测补正，原实现只转义引号）。
  const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  let head = `${params.date} ${flag}`
  if (params.payee && params.narration) {
    head += ` ${quote(params.payee)} ${quote(params.narration)}`
  } else if (params.payee) {
    head += ` ${quote(params.payee)}`
  } else if (params.narration) {
    // beancount 单字符串归 payee，故只有 narration 时补空 payee 占位
    head += ` ${quote('')} ${quote(params.narration)}`
  }
  // link 跟在 payee/narration 之后（beancount 顺序：日期 标志 "payee" "narration" #tag ^link）
  for (const link of params.links ?? []) head += ` ^${link}`
  const meta: string[] = []
  if (params.id) meta.push(`  id: ${quote(params.id)}`)
  if (params.time) meta.push(`  time: ${quote(params.time)}`)
  const body: string[] = []
  for (const p of params.postings) {
    body.push(`  ${p.account}  ${p.number} ${p.currency}`)
    if (p.counterparty) body.push(`    counterparty: ${quote(p.counterparty)}`)
  }
  const lines = [head, ...meta, ...body]
  return lines.join('\n') + '\n'
}

/**
 * 新建账本选项头部：title + operating_currency。
 * （2026-08-23 回归修复：运营货币缺失时报表趋势/收支图按 '' 过滤恒空，
 * 首笔录入 / 清空重录 / 空账本 Excel 导入生成的账本必须带 option。）
 */
export function serializeOptionsHeader(currency: string): string {
  return `option "title" "BeanWise"\noption "operating_currency" "${currency}"\n\n`
}

/**
 * 首文件场景的完整文本块：options 头 + 交易涉及账户的 open 行 + 交易块。
 * （2026-08-09 实测：beancount v3 对未 open 账户报 ValidationError，空账本首笔
 * 必须补 open 才能通过校验；同日 open + 交易 0 错误。）
 * open 日期取交易日期；账户按 posting 顺序去重；运营货币取首笔 posting 币种。
 */
export function serializeFirstEntryBlock(params: AddEntryParams): string {
  const currency = params.postings[0]?.currency ?? ''
  const seen = new Set<string>()
  const opens: string[] = []
  for (const p of params.postings) {
    if (!seen.has(p.account)) {
      seen.add(p.account)
      opens.push(`${params.date} open ${p.account}`)
    }
  }
  return serializeOptionsHeader(currency) + opens.join('\n') + '\n' + serializeEntry(params)
}

/**
 * 找出账本内容中尚未 open 的账户（按出现顺序去重）。
 * 用于追加场景：自动补的反向分录账户（如 Equity:AutoBalance）可能不在已有账本中，
 * 需要在交易前补 open 行，否则 Beancount 校验报 "Invalid reference to unknown account"。
 */
export function findUnopenedAccounts(content: string, accounts: string[]): string[] {
  const openRe = /^(\d{4}-\d{2}-\d{2})\s+open\s+(.+)$/gm
  const opened = new Set<string>()
  let m
  while ((m = openRe.exec(content)) !== null) {
    opened.add(m[2].trim())
  }
  const seen = new Set<string>()
  return accounts.filter((a) => {
    if (seen.has(a) || opened.has(a)) return false
    seen.add(a)
    return true
  })
}

/** 为未 open 的账户生成 open 行前缀（含末尾换行）；全部已 open 则返回空串。 */
export function serializeOpenLines(date: string, accounts: string[]): string {
  if (accounts.length === 0) return ''
  return accounts.map((a) => `${date} open ${a}`).join('\n') + '\n'
}
