import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { asc, eq } from 'drizzle-orm'
import type { DrizzleDb } from './db'
import { entries, ledgerMeta, postings } from './db/schema'
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
}

export interface ListEntriesParams {
  limit?: number // 默认 100，上限 1000
  offset?: number // 默认 0，>= 0
}

export interface ListEntriesResult {
  entries: LedgerEntryRow[]
  total: number
}

function sha256File(filename: string): string {
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

export function listEntries(db: DrizzleDb, limit: number, offset: number): ListEntriesResult {
  // total 用全表计数：M3 账本量级小可接受；大账本（>5 万笔）优化点见 roadmap 待定项
  const total = db.select().from(entries).all().length
  const rows = db
    .select()
    .from(entries)
    .orderBy(asc(entries.date), asc(entries.id))
    .limit(limit)
    .offset(offset)
    .all()
  return { entries: rows as LedgerEntryRow[], total }
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
