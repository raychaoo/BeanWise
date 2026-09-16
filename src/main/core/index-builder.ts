import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { DrizzleDb } from '../db/index'
import { entries, entryLinks, ledgerMeta, postings } from '../db/schema'
import { accountType, isPnlAccountType } from '../../shared/account'
import { addDecimalStrings, negateDecimal, normalizeAmountMagnitude } from '../../shared/decimal'
import { isNewLoanPosting } from './loan-links'
import type { PythonSvc } from './python-svc'

export type LedgerIndexStatus = 'ok' | 'error' | 'missing'

/**
 * 交易类型（金额列的类型标记，2026-09-16）：色与标签都据此定，口径**只在主进程算一次**。
 *
 * - 损益（有 Income/Expenses 腿）：`income` / `expense`——按 `pnlAccount` 的**账户类型**判定而非金额
 *   正负：退款冲减支出是一笔正数，但它仍属支出类目。
 * - 往来（账户库 `counterparty` 标志的账户参与，ADR 23）：按 [`isNewLoanPosting`](./loan-links.ts)
 *   的「新增欠款」方向二分——`Assets 正 / Liabilities 负` = 欠款增加，故 `Assets → lend`（借出，
 *   我方应收增加）、`Liabilities → borrow`（借入，我方应付增加）；反向即债权的收回与债务的偿还。
 * - 搬移（无损益、无往来）：含 Equity 腿 → `equity`（权益调整 / 期初余额），其余 → `transfer`。
 * - 无金额的条目（Open / Balance / Note）→ null。
 */
export type TxKind =
  | 'income'
  | 'expense'
  | 'lend'
  | 'borrow'
  | 'recover'
  | 'repay'
  | 'transfer'
  | 'equity'

export interface RefreshResult {
  /** 内容未变（hash 相同）→ false；未变时 status 反映当前索引状态 */
  changed: boolean
  status: LedgerIndexStatus
  entryCount: number
  errorCount: number
  message?: string
}

export interface LedgerStatus {
  path: string
  title: string | null
  operatingCurrency: string[]
  entryCount: number
  errorCount: number
  status: LedgerIndexStatus
  lastError: string | null
  updatedAt: number | null
}

export interface LedgerEntryRow {
  id: number
  type: string
  date: string
  externalId: string | null
  time: string | null
  flag: string | null
  payee: string | null
  narration: string | null
  account: string | null
  lineno: number | null
  /** 交易金额（超 UI 层 #1）：主币种下 PL 侧（Income/Expenses）金额和取反——资产流视角
   * （收入 +、支出 -，十进制字符串）；无 PL posting（转账/Open 等）或运算异常 → null */
  amount: string | null
  currency: string | null
  /** PL 侧账户路径（Income/Expenses 中主币种下的首个 posting 账户），用于流水列表显示支出/收入账户中文名；
   * 无 PL posting（转账/Open 等）→ null */
  pnlAccount: string | null
  /** 账内搬移（无 PL posting 的交易：转账 / 信用卡还款 / 往来借出还款 / 权益调整）的资金流出账户
   * （负腿，posting 原序去重）；有损益腿或无分录 → [] */
  flowFrom: string[]
  /** 同上，资金流入账户（正腿） */
  flowTo: string[]
  /** 账内搬移的发生额（正腿之和，正数、同 currency 口径）；有损益腿或无分录 → null */
  flowAmount: string | null
  /** 交易类型（金额列的类型标记）：着色与文字标签的依据；无金额的条目 → null */
  txKind: TxKind | null
}

export interface ListEntriesParams {
  limit?: number // 默认 100，上限 1000
  offset?: number // 默认 0，>= 0
  /** date 排序方向（ORDER BY date,id 同向）；默认 'asc' 保持既有语义，明细页传 'desc' 实现全库倒序分页 */
  order?: 'asc' | 'desc'
  /** 起止日期（含端点，YYYY-MM-DD）；超 UI 层 #2：服务端时间过滤 */
  dateFrom?: string
  dateTo?: string
  /** 搜索词：payee/narration/交易 ID/账户（postings.account）任一命中即整笔交易命中；不含金额 */
  keyword?: string
  /** 金额搜索（独立入参，不与 keyword 混用）：十进制字符串，按**绝对值**精确匹配任一 posting 的
   * units_number——不看正负、忽略小数尾零（'14' / '14.0' / '14.00' 等价，'14' 不命中 145.00） */
  amount?: string
  /** 账户精确过滤（超 UI 层 #2 收尾）：精确匹配 postings.account，不做前缀展开（层级聚合是余额表职责）；
   * 明细账视角 = 该账户自身分录流，命中交易的其他 posting 行不自动带出；与 keyword/date* 叠加为 AND 语义 */
  account?: string
}

export interface ListEntriesFilters {
  dateFrom?: string
  dateTo?: string
  keyword?: string
  amount?: string
  account?: string
}

export interface ListEntriesResult {
  entries: LedgerEntryRow[]
  total: number
}

/** 单笔交易详情：按稳定 ID 读取，供编辑表单完整回填（含全部 posting 与 link）。 */
export interface LedgerEntryDetail {
  id: string
  date: string
  time: string
  flag?: '*' | '!'
  payee?: string
  narration?: string
  links: string[]
  postings: Array<{
    account: string
    number: string
    currency: string
    counterparty?: string
  }>
}

// M5：编辑器保存链路复用（ledger:read-file 打开基线 / ledger:save-file 冲突比对）
export function sha256File(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

/** 单行 meta upsert：行不存在则插入（首刷即失败/缺失的场景），存在则更新。 */
function upsertMeta(db: DrizzleDb, patch: Partial<typeof ledgerMeta.$inferInsert> & { id: number }): void {
  const existing = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
  if (existing) {
    db.update(ledgerMeta).set(patch).where(eq(ledgerMeta.id, 1)).run()
  } else {
    db.insert(ledgerMeta).values({ ...patch, ledgerPath: patch.ledgerPath ?? '' }).run()
  }
}

/**
 * 索引重建管线（数据流铁律：先校验 → 通过才重建；失败保持旧索引）：
 * 1. 文件不存在 → status='missing'
 * 2. hash 变更检测：仅当缓存 status='ok' 且 hash 相同 → 跳过（changed=false）；
 *    error/missing 一律重新解析（错误路径不更新 fileHash，文件回退到旧 ok 内容时
 *    若只比对 hash 会误跳过并残留 stale error）
 * 3. parse_entries 校验：errors 非空 → status='error'，不重建
 * 4. 事务：清空 postings/entries → 全量插入 → 更新 ledger_meta
 * 注意：M3 的「增量」= 变更检测跳过；解析与重建本身是全量的（引擎无状态）。
 */
export async function refreshIndex(
  db: DrizzleDb,
  engine: PythonSvc,
  ledgerPath: string
): Promise<RefreshResult> {
  let fileHash = ''
  let mtimeMs = 0
  try {
    fileHash = sha256File(ledgerPath)
    mtimeMs = statSync(ledgerPath).mtimeMs
  } catch {
    upsertMeta(db, { id: 1, ledgerPath, status: 'missing', updatedAt: Date.now() })
    return { changed: true, status: 'missing', entryCount: 0, errorCount: 0 }
  }

  const meta = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
  if (meta?.fileHash === fileHash && meta.status === 'ok') {
    return {
      changed: false,
      status: meta.status,
      entryCount: meta.entryCount,
      errorCount: meta.errorCount
    }
  }

  let parsed
  try {
    parsed = await engine.parseEntries(ledgerPath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    upsertMeta(db, { id: 1, ledgerPath, status: 'error', lastError: message, updatedAt: Date.now() })
    const stale = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
    return {
      changed: true,
      status: 'error',
      entryCount: stale?.entryCount ?? 0,
      errorCount: stale?.errorCount ?? 0,
      message
    }
  }

  if (parsed.errors.length > 0) {
    const message = parsed.errors.map((e) => e.message).join('; ')
    upsertMeta(db, {
      id: 1,
      ledgerPath,
      status: 'error',
      lastError: message,
      errorCount: parsed.errors.length,
      updatedAt: Date.now()
    })
    const stale = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
    return {
      changed: true,
      status: 'error',
      entryCount: stale?.entryCount ?? 0,
      errorCount: parsed.errors.length,
      message
    }
  }

  // 事务只重建 entries/postings；meta 在事务成功后单独 upsert（事务失败则不更新 meta，
  // 索引整体保持旧状态；两步间窗口毫秒级且索引可随时重建，可接受）。
  // 注意：drizzle better-sqlite3 驱动下 db.transaction 同步执行（BEGIN…COMMIT 包住回调），
  // 返回回调结果；事务内只能同步 API（delete/insert…run），await 一律在事务外。
  db.transaction((drizzle) => {
    drizzle.delete(entryLinks).run()
    drizzle.delete(postings).run()
    drizzle.delete(entries).run()
    for (const entry of parsed.entries) {
      const inserted = drizzle
        .insert(entries)
        .values({
          type: entry.type as string,
          date: entry.date as string,
          externalId: (entry.id as string | null) ?? null,
          time: (entry.time as string | null) ?? null,
          flag: (entry.flag as string | null) ?? null,
          payee: (entry.payee as string | null) ?? null,
          narration: (entry.narration as string | null) ?? null,
          account: (entry.account as string | null) ?? null,
          lineno: (entry.lineno as number | null) ?? null
        })
        .returning()
        .get()
      for (const p of (entry.postings as Array<Record<string, unknown>> | undefined) ?? []) {
        drizzle
          .insert(postings)
          .values({
            entryId: inserted.id,
            account: p.account as string,
            unitsNumber: p.units_number as string,
            unitsCurrency: p.units_currency as string,
            costNumber: (p.cost_number as string | null) ?? null,
            costCurrency: (p.cost_currency as string | null) ?? null,
            counterparty: (p.counterparty as string | null) ?? null
          })
          .run()
      }
      // 交易级 link（ADR 23 P2 核销）：一笔可有多个，逐条落行
      for (const link of (entry.links as string[] | undefined) ?? []) {
        drizzle.insert(entryLinks).values({ entryId: inserted.id, link }).run()
      }
    }
  })

  upsertMeta(db, {
    id: 1,
    ledgerPath,
    title: parsed.options.title as string | null,
    operatingCurrency: JSON.stringify(parsed.options.operating_currency ?? []),
    mtimeMs,
    fileHash,
    entryCount: parsed.entries.length,
    errorCount: 0,
    status: 'ok',
    lastError: null,
    updatedAt: Date.now()
  })

  return {
    changed: true,
    status: 'ok',
    entryCount: parsed.entries.length,
    errorCount: 0
  }
}

export function getLedgerStatus(db: DrizzleDb): LedgerStatus | null {
  const meta = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
  if (!meta) return null
  return {
    path: meta.ledgerPath,
    title: meta.title,
    operatingCurrency: parseJsonArray(meta.operatingCurrency),
    entryCount: meta.entryCount,
    errorCount: meta.errorCount,
    status: meta.status,
    lastError: meta.lastError,
    updatedAt: meta.updatedAt
  }
}

/** 按交易级稳定 ID 读取完整交易。只返回 Transaction；ID 不存在/不是交易 → null。 */
export function getEntryById(db: DrizzleDb, externalId: string): LedgerEntryDetail | null {
  const row = db.select().from(entries).where(eq(entries.externalId, externalId)).get()
  if (!row || row.type !== 'Transaction' || !row.externalId) return null

  const detailPostings = db
    .select()
    .from(postings)
    .where(eq(postings.entryId, row.id))
    .orderBy(asc(postings.id))
    .all()
  const links = db
    .select()
    .from(entryLinks)
    .where(eq(entryLinks.entryId, row.id))
    .orderBy(asc(entryLinks.id))
    .all()
    .map((item) => item.link)

  return {
    id: row.externalId,
    date: row.date,
    // 历史交易没有 time metadata 时按午夜回填，编辑保存后补成合法秒级 metadata。
    time: row.time ?? `${row.date} 00:00:00`,
    ...(row.flag === '*' || row.flag === '!' ? { flag: row.flag } : {}),
    ...(row.payee !== null ? { payee: row.payee } : {}),
    ...(row.narration !== null ? { narration: row.narration } : {}),
    links,
    postings: detailPostings.map((p) => ({
      account: p.account,
      number: p.unitsNumber,
      currency: p.unitsCurrency,
      ...(p.counterparty !== null ? { counterparty: p.counterparty } : {})
    }))
  }
}

/** 明细行的金额/账户增强（超 UI 层 #1 + 账内搬移补全）
 *
 * ① 有损益腿（Income/Expenses）的交易：`amount` = 主币种（运营货币优先，缺省取首笔 posting 币种）
 *    下损益腿之和取反——资产流视角（支出 → 负、收入 → 正）；`pnlAccount` = 首个损益账户路径，
 *    供流水列表显示支出/收入类目。
 * ② 无损益腿的交易（转账 / 信用卡还款 / 往来借出还款 / 权益调整等**账内搬移**）：搬移不产生损益，
 *    故 `amount` 恒为 null，改由 `flowFrom`/`flowTo`（资金流出 / 流入账户，按符号分组、posting
 *    原序去重）与 `flowAmount`（发生额）描述——否则这类行在明细页「账户」「金额」两列都是「—」。
 * ③ 无分录条目（Open/Balance 等）或运算异常：全空。
 *
 * 同时定 `txKind`（金额列的类型标记，2026-09-16）：损益腿 → `income`/`expense`（按账户类型而非
 * 金额正负）；账内搬移 → 往来类账户参与则按 [`isNewLoanPosting`](./loan-links.ts) 的欠款方向二分，
 * 否则含 Equity 腿为 `equity`、其余为 `transfer`。类型判定与金额同在**主进程**算：往来类账户须读
 * 账户库（main 的 `counterpartyAccounts()` 不过滤 enabled，停用账户的历史借出仍能正确标记），
 * 且与「口径收在主进程」（超 UI 层 #1）一致。
 *
 * 「有无损益腿」按**全币种**判定：运营货币下恰好没有损益腿的外币收支交易仍属损益类，不可退化成
 * 账内搬移（否则会被显示成「A → B」账户串）。求和一律走 shared/decimal 十进制字符串运算。
 */
interface EntryAmount {
  amount: string | null
  currency: string | null
  pnlAccount: string | null
  flowFrom: string[]
  flowTo: string[]
  flowAmount: string | null
  txKind: TxKind | null
}

type PostingLike = { account: string; unitsNumber: string; unitsCurrency: string }

function emptyAmount(currency: string | null = null): EntryAmount {
  return { amount: null, currency, pnlAccount: null, flowFrom: [], flowTo: [], flowAmount: null, txKind: null }
}

/** 账内搬移的账户串 + 发生额：负腿 = 资金流出方、正腿 = 流入方（各自去重保序）；
 *  发生额取正腿之和（复式记账下与负腿之和互为相反数，取任一侧即搬移规模）。 */
function entryFlow(ps: PostingLike[]): Pick<EntryAmount, 'flowFrom' | 'flowTo' | 'flowAmount'> {
  const flowFrom: string[] = []
  const flowTo: string[] = []
  let inflow = '0'
  let outflow = '0'
  for (const p of ps) {
    if (p.unitsNumber.startsWith('-')) {
      if (!flowFrom.includes(p.account)) flowFrom.push(p.account)
      outflow = addDecimalStrings(outflow, p.unitsNumber)
    } else {
      if (!flowTo.includes(p.account)) flowTo.push(p.account)
      inflow = addDecimalStrings(inflow, p.unitsNumber)
    }
  }
  return { flowFrom, flowTo, flowAmount: inflow !== '0' ? inflow : negateDecimal(outflow) }
}

/** 账内搬移的交易类型：往来类账户参与 → 按欠款方向二分（借出/借入 vs 收回/还款）；
 *  否则含 Equity 腿为权益调整、其余为普通转账。 */
function flowKind(ps: PostingLike[], counterpartyAccounts: readonly string[]): TxKind {
  const hit = ps.find((p) => counterpartyAccounts.includes(p.account))
  if (hit) {
    const asset = accountType(hit.account) === 'Assets'
    return isNewLoanPosting(hit.account, hit.unitsNumber)
      ? (asset ? 'lend' : 'borrow')
      : (asset ? 'recover' : 'repay')
  }
  return ps.some((p) => accountType(p.account) === 'Equity') ? 'equity' : 'transfer'
}

function entryAmount(
  ps: PostingLike[],
  primaryCurrency: string | null,
  counterpartyAccounts: readonly string[] = []
): EntryAmount {
  if (ps.length === 0) return emptyAmount()
  const currency = primaryCurrency ?? ps[0]!.unitsCurrency
  if (!ps.some((p) => isPnlAccountType(accountType(p.account)))) {
    try {
      return { ...emptyAmount(currency), ...entryFlow(ps), txKind: flowKind(ps, counterpartyAccounts) }
    } catch {
      return emptyAmount(currency)
    }
  }
  const pl = ps.filter((p) => p.unitsCurrency === currency && isPnlAccountType(accountType(p.account)))
  if (pl.length === 0) return emptyAmount(currency)
  try {
    const sum = pl.reduce((acc, p) => addDecimalStrings(acc, p.unitsNumber), '0')
    return {
      ...emptyAmount(currency),
      amount: negateDecimal(sum),
      pnlAccount: pl[0]!.account,
      // 按账户类型判收支（不按金额正负）：退款/冲销的金额是正的，但仍属支出类目
      txKind: accountType(pl[0]!.account) === 'Income' ? 'income' : 'expense'
    }
  } catch {
    return emptyAmount(currency)
  }
}

export function listEntries(
  db: DrizzleDb,
  limit: number,
  offset: number,
  order: 'asc' | 'desc' = 'asc',
  filters?: ListEntriesFilters,
  /** 往来类账户路径（账户库 counterparty 标志）：`txKind` 据此区分借出/还款与普通转账。
   *  未传 → 往来类交易退化为 `transfer`/`equity`（默认不误标），先例同 `loadLoanRows(db, accounts)`。 */
  counterpartyAccounts: readonly string[] = []
): ListEntriesResult {
  // 过滤条件（超 UI 层 #2）：日期含端点（YYYY-MM-DD 字典序即时间序）+ 关键词交易级命中 + 账户精确过滤。
  // LIKE 手工转义 % _ \，ESCAPE '\' 保证搜索词按字面匹配。
  const conds: SQL[] = []
  if (filters?.dateFrom) conds.push(gte(entries.date, filters.dateFrom))
  if (filters?.dateTo) conds.push(lte(entries.date, filters.dateTo))
  if (filters?.account !== undefined) {
    // 入参校验：非空字符串、长度上限 200（与 keyword 上限一致）
    if (typeof filters.account !== 'string' || filters.account.length === 0 || filters.account.length > 200) {
      throw new Error('account 必须是不超过 200 字的非空字符串')
    }
    // 精确匹配（drizzle 参数化，无注入面）：postings 逐行 EXISTS，命中行的同笔交易其他 posting 行不自动带出
    conds.push(
      sql`EXISTS (SELECT 1 FROM postings WHERE postings.entry_id = ${entries.id} AND postings.account = ${filters.account})`
    )
  }
  if (filters?.keyword) {
    const escaped = filters.keyword.replace(/[\\%_]/g, '\\$&')
    const kw = `%${escaped}%`
    conds.push(
      sql`(${entries.payee} LIKE ${kw} ESCAPE '\\' OR ${entries.narration} LIKE ${kw} ESCAPE '\\' OR ${entries.externalId} LIKE ${kw} ESCAPE '\\' OR ${entries.account} LIKE ${kw} ESCAPE '\\' OR EXISTS (SELECT 1 FROM postings WHERE postings.entry_id = ${entries.id} AND postings.account LIKE ${kw} ESCAPE '\\'))`
    )
  }
  if (filters?.amount !== undefined) {
    // 金额搜索（独立入参）：与 keyword 的文本 LIKE 分开，避免「搜 15」被说明里的数字/账户名污染。
    // 两侧同为「去符号 + 去小数尾零」的规范串再比相等——金额精度写法不定（0/1/2 位小数并存），
    // 逐字 LIKE 会让 14 漏掉 14.00 又误命中 145.00；不取子串、不引浮点。
    const magnitude = normalizeAmountMagnitude(filters.amount)
    if (magnitude === null) throw new Error('amount 必须是十进制数值字符串（如 15、15.4）')
    conds.push(
      sql`EXISTS (SELECT 1 FROM postings WHERE postings.entry_id = ${entries.id} AND (CASE WHEN instr(postings.units_number, '.') > 0 THEN rtrim(rtrim(replace(postings.units_number, '-', ''), '0'), '.') ELSE replace(postings.units_number, '-', '') END) = ${magnitude})`
    )
  }
  const where = conds.length > 0 ? and(...conds) : undefined

  // total 与数据同条件计数：分页器展示过滤后的真实总数
  const total = db.select({ n: sql<number>`count(*)` }).from(entries).where(where).get()?.n ?? 0

  // date 与 id 同向排序：倒序时同日条目也按写入先后倒排（分页语义在任意方向下均稳定）
  const dir = order === 'desc' ? desc : asc
  const rows = db
    .select()
    .from(entries)
    .where(where)
    .orderBy(dir(entries.date), dir(entries.id))
    .limit(limit)
    .offset(offset)
    .all()

  // 金额增强：本页 entries 的 postings 一次取回，内存按 entry 分组计算（页大小 ≤1000，开销可忽略）
  const ids = rows.map((r) => r.id)
  const pagePostings = ids.length > 0 ? db.select().from(postings).where(inArray(postings.entryId, ids)).all() : []
  const byEntry = new Map<number, Array<{ account: string; unitsNumber: string; unitsCurrency: string }>>()
  for (const p of pagePostings) {
    const list = byEntry.get(p.entryId)
    const item = { account: p.account, unitsNumber: p.unitsNumber, unitsCurrency: p.unitsCurrency }
    if (list) list.push(item)
    else byEntry.set(p.entryId, [item])
  }
  const primaryCurrency = parseJsonArray(
    db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()?.operatingCurrency ?? null
  )[0] ?? null

  const out = rows.map((r) => ({
    ...r,
    ...entryAmount(byEntry.get(r.id) ?? [], primaryCurrency, counterpartyAccounts)
  }))
  return { entries: out as LedgerEntryRow[], total }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}
