import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type DrizzleDb = ReturnType<typeof createDrizzle>

/**
 * 索引 schema 版本（PRAGMA user_version）。索引是纯缓存、唯一事实源是账本文件，
 * 故版本不符即整表丢弃重建，由 refreshIndex 按文件重新填充——`CREATE TABLE IF NOT EXISTS`
 * 无法给已存在的表补列，加列必须走这道闸门（drizzle 不生成 DDL，无需手写 migration）。
 * 版本史：1 = 初版；2 = postings 加 counterparty（往来对象，ADR 23）；
 * 3 = 新增 entry_links（交易级 link，ADR 23 P2 核销）；
 * 4 = entries 加 external_id/time（稳定交易 ID + 秒级时间）。
 */
export const SCHEMA_VERSION = 4

/** 建表 DDL。与 schema.ts 表定义一一对应（drizzle 不生成 DDL，索引可随时重建，无需 migration）。 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS ledger_meta (
  id INTEGER PRIMARY KEY,
  ledger_path TEXT NOT NULL,
  title TEXT,
  operating_currency TEXT,
  mtime_ms INTEGER,
  file_hash TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'missing',
  last_error TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  external_id TEXT,
  time TEXT,
  flag TEXT,
  payee TEXT,
  narration TEXT,
  account TEXT,
  lineno INTEGER
);
CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  units_number TEXT NOT NULL,
  units_currency TEXT NOT NULL,
  cost_number TEXT,
  cost_currency TEXT,
  counterparty TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_external_id ON entries(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account);
CREATE INDEX IF NOT EXISTS idx_postings_entry ON postings(entry_id);
CREATE INDEX IF NOT EXISTS idx_postings_counterparty ON postings(counterparty);
CREATE TABLE IF NOT EXISTS entry_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  link TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entry_links_link ON entry_links(link);
CREATE INDEX IF NOT EXISTS idx_entry_links_entry ON entry_links(entry_id);
`

export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // 版本闸门：旧索引表结构直接丢弃（纯缓存可随时重建），refreshIndex 随后按文件重新填充
  if ((db.pragma('user_version', { simple: true }) as number) !== SCHEMA_VERSION) {
    db.exec(
      'DROP TABLE IF EXISTS entry_links; DROP TABLE IF EXISTS postings; DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS ledger_meta;'
    )
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  db.exec(SCHEMA_DDL)
  return db
}

export function createDrizzle(db: Database.Database): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(db, { schema })
}
