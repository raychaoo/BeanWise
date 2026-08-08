import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type DrizzleDb = ReturnType<typeof createDrizzle>

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
  cost_currency TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account);
CREATE INDEX IF NOT EXISTS idx_postings_entry ON postings(entry_id);
`

export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_DDL)
  return db
}

export function createDrizzle(db: Database.Database): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(db, { schema })
}
