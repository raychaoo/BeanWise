/**
 * 贷款核销（ADR 23 P2）：交易级 `^link` 的生成、解析与核销口径。
 *
 * 约定（ADR 23 ④）：
 * - **一个 link 值 = 一笔贷款**，格式 `lend-<base36 时间><10 位随机>`；创建时盖一次、
 *   此后永不变更——**不派生自日期/金额**，改账不悬空。
 * - **借出笔**挂自身贷款 ID；**还款笔**挂它所结清的贷款 ID。两者前缀相同，故某笔贷款的
 *   未结额 = 所有带该 link 的交易在往来类账户上的分录之和（借出为正、还款为负）。
 * - **一笔还款只挂一个 link**：link 无「金额」可言，挂多个会让每笔都被全额冲减、
 *   账目失真。一次还多笔请分录两笔交易。
 * - link 挂在交易级——beancount 的 `^link` 写在 posting 上是语法错误（实测）。
 */
import { eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '../db'
import { entries, entryLinks, postings } from '../db/schema'
import { accountType } from '../../shared/account'
import { addDecimalStrings, negateDecimal } from '../../shared/decimal'
import type { CounterpartyLoan } from '../../shared/ipc'

export const LOAN_PREFIX = 'lend-'

/**
 * 生成贷款 ID：`lend-<base36 时间戳><10 位随机>`，纯 ASCII（beancount link 词法受限）。
 * 时间前缀只为排查方便，唯一性由随机段保证。
 */
export function newLoanId(random: () => number = Math.random, now: () => number = Date.now): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let suffix = ''
  for (let i = 0; i < 10; i++) suffix += alphabet[Math.floor(random() * alphabet.length)]
  return `${LOAN_PREFIX}${now().toString(36)}${suffix}`
}

/** 零值判断（十进制字符串，禁 Number）。'0' / '-0.00' / '0.0' → true */
const ZERO_RE = /^-?0+(\.0+)?$/

/**
 * 该分录是否为「新借出」（相对往来类账户的方向）：
 * 资产侧应收增加（正）、负债侧应付增加（负）。还款方向相反 → false。
 */
export function isNewLoanPosting(account: string, number: string): boolean {
  if (ZERO_RE.test(number)) return false
  const type = accountType(account)
  if (type === 'Assets') return !number.startsWith('-')
  if (type === 'Liabilities') return number.startsWith('-')
  return false
}

/** 贷款核销输入行：一条 (link × 往来类分录) 展开行（同笔交易多 link 会展开成多行） */
export interface LoanPostingRow {
  entryId: number
  date: string
  account: string
  number: string
  currency: string
  counterparty: string | null
  link: string
}

/** 单笔贷款核销状态（类型定义在 shared/ipc.ts —— 需跨 IPC 到渲染端） */
export type LoanRow = CounterpartyLoan

/**
 * 按 link 聚合核销状态。同一 link 上的所有分录合并——借出为正、还款为负，
 * 故未结 = Σ 各分录（负债侧先取反，统一到「对方欠我」口径，与 computeCounterpartyLedger 一致）。
 * 输出按日期升序（同日期按 id），供 FIFO 取「最早的未结」。
 */
export function computeLoanLedger(rows: LoanPostingRow[]): LoanRow[] {
  const grouped = new Map<string, LoanPostingRow[]>()
  for (const r of rows) {
    const hit = grouped.get(r.link)
    if (hit) hit.push(r)
    else grouped.set(r.link, [r])
  }
  const out: LoanRow[] = []
  for (const [id, group] of grouped) {
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date) || a.entryId - b.entryId)
    let principal = '0'
    let settled = '0'
    for (const r of sorted) {
      // 负债侧取反：借入时该账户记负，取反后与本方「应收」同向，借方记正
      const delta = accountType(r.account) === 'Liabilities' ? negateDecimal(r.number) : r.number
      if (delta.startsWith('-')) settled = addDecimalStrings(settled, negateDecimal(delta))
      else principal = addDecimalStrings(principal, delta)
    }
    const outstanding = addDecimalStrings(principal, negateDecimal(settled))
    out.push({
      id,
      counterparty: sorted.find((r) => r.counterparty !== null)?.counterparty ?? null,
      date: sorted[0]!.date,
      currency: sorted[0]!.currency,
      principal,
      settled,
      outstanding,
      closed: outstanding.startsWith('-') || ZERO_RE.test(outstanding)
    })
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  return out
}

/** FIFO：该对象最早的未结贷款 ID（loans 须已按日期升序，见 computeLoanLedger 的排序） */
export function pickOpenLoanId(loans: LoanRow[], counterparty: string): string | undefined {
  return loans.find((l) => l.counterparty === counterparty && !l.closed)?.id
}

/**
 * 载入贷款核销行：link × 往来类账户分录。无 link 的交易不参与（旧数据未回填时为空集）。
 */
export function loadLoanRows(db: DrizzleDb, accounts: readonly string[]): LoanPostingRow[] {
  if (accounts.length === 0) return []
  return db
    .select({
      entryId: entries.id,
      date: entries.date,
      account: postings.account,
      number: postings.unitsNumber,
      currency: postings.unitsCurrency,
      counterparty: postings.counterparty,
      link: entryLinks.link
    })
    .from(entryLinks)
    .innerJoin(entries, eq(entryLinks.entryId, entries.id))
    .innerJoin(postings, eq(postings.entryId, entries.id))
    .where(inArray(postings.account, accounts))
    .all()
}
