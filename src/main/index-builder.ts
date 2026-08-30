import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { DrizzleDb } from './db'
import { entries, ledgerMeta, postings } from './db/schema'
import { accountType, isPnlAccountType } from '../shared/account'
import { addDecimalStrings, negateDecimal } from '../shared/decimal'
import type { PythonSvc } from './python-svc'

export type LedgerIndexStatus = 'ok' | 'error' | 'missing'

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
  flag: string | null
  payee: string | null
  narration: string | null
  account: string | null
  lineno: number | null
  /** 交易金额（超 UI 层 #1）：主币种下 PL 侧（Income/Expenses）金额和取反——资产流视角
   * （收入 +、支出 -，十进制字符串）；无 PL posting（转账/Open 等）或运算异常 → null */
  amount: string | null
  currency: string | null
}

export interface ListEntriesParams {
  limit?: number // 默认 100，上限 1000
  offset?: number // 默认 0，>= 0
  /** date 排序方向（ORDER BY date,id 同向）；默认 'asc' 保持既有语义，明细页传 'desc' 实现全库倒序分页 */
  order?: 'asc' | 'desc'
  /** 起止日期（含端点，YYYY-MM-DD）；超 UI 层 #2：服务端时间过滤 */
  dateFrom?: string
  dateTo?: string
  /** 搜索词：payee/narration/账户（entry 自身 account 或 postings.account）任一命中即整笔交易命中 */
  keyword?: string
  /** 账户精确过滤（超 UI 层 #2 收尾）：精确匹配 postings.account，不做前缀展开（层级聚合是余额表职责）；
   * 明细账视角 = 该账户自身分录流，命中交易的其他 posting 行不自动带出；与 keyword/date* 叠加为 AND 语义 */
  account?: string
}

export interface ListEntriesFilters {
  dateFrom?: string
  dateTo?: string
  keyword?: string
  account?: string
}

export interface ListEntriesResult {
  entries: LedgerEntryRow[]
  total: number
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
    drizzle.delete(postings).run()
    drizzle.delete(entries).run()
    for (const entry of parsed.entries) {
      const inserted = drizzle
        .insert(entries)
        .values({
          type: entry.type as string,
          date: entry.date as string,
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
            costCurrency: (p.cost_currency as string | null) ?? null
          })
          .run()
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

/** 交易金额计算（超 UI 层 #1）：主币种（运营货币优先，缺省取首笔 posting 币种）下 PL 侧
 * 金额和取反——资产流视角（支出 → 负、收入 → 正）；无 PL posting（转账/Open）→ null。
 * 求和走 shared/decimal 十进制字符串运算（禁浮点），异常兜底 null 不阻塞列表。 */
function entryAmount(
  ps: Array<{ account: string; unitsNumber: string; unitsCurrency: string }>,
  primaryCurrency: string | null
): { amount: string | null; currency: string | null } {
  if (ps.length === 0) return { amount: null, currency: null }
  const currency = primaryCurrency ?? ps[0]!.unitsCurrency
  const pl = ps.filter((p) => p.unitsCurrency === currency && isPnlAccountType(accountType(p.account)))
  if (pl.length === 0) return { amount: null, currency }
  try {
    const sum = pl.reduce((acc, p) => addDecimalStrings(acc, p.unitsNumber), '0')
    return { amount: negateDecimal(sum), currency }
  } catch {
    return { amount: null, currency }
  }
}

export function listEntries(
  db: DrizzleDb,
  limit: number,
  offset: number,
  order: 'asc' | 'desc' = 'asc',
  filters?: ListEntriesFilters
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
    const kw = `%${filters.keyword.replace(/[\\%_]/g, '\\$&')}%`
    conds.push(
      sql`(${entries.payee} LIKE ${kw} ESCAPE '\\' OR ${entries.narration} LIKE ${kw} ESCAPE '\\' OR ${entries.account} LIKE ${kw} ESCAPE '\\' OR EXISTS (SELECT 1 FROM postings WHERE postings.entry_id = ${entries.id} AND postings.account LIKE ${kw} ESCAPE '\\'))`
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

  const out = rows.map((r) => {
    const { amount, currency } = entryAmount(byEntry.get(r.id) ?? [], primaryCurrency)
    return { ...r, amount, currency }
  })
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
