import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** SQLite 索引表结构（M3 定稿，M4-M8 直接引用）。金额一律 TEXT（Decimal 精度）。 */

export const ledgerMeta = sqliteTable('ledger_meta', {
  id: integer('id').primaryKey(), // 恒为 1（单行）
  ledgerPath: text('ledger_path').notNull(),
  title: text('title'),
  operatingCurrency: text('operating_currency'), // JSON 数组字符串，如 '["CNY"]'
  mtimeMs: integer('mtime_ms'),
  fileHash: text('file_hash'),
  entryCount: integer('entry_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  status: text('status', { enum: ['ok', 'error', 'missing'] }).notNull().default('missing'),
  lastError: text('last_error'),
  updatedAt: integer('updated_at') // epoch ms
})

export const entries = sqliteTable('entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  date: text('date').notNull(), // ISO YYYY-MM-DD，字符串排序即时间序
  flag: text('flag'),
  payee: text('payee'),
  narration: text('narration'),
  account: text('account'), // 仅 Open 条目
  lineno: integer('lineno')
})

export const postings = sqliteTable('postings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entryId: integer('entry_id')
    .notNull()
    .references(() => entries.id, { onDelete: 'cascade' }),
  account: text('account').notNull(),
  unitsNumber: text('units_number').notNull(),
  unitsCurrency: text('units_currency').notNull(),
  costNumber: text('cost_number'),
  costCurrency: text('cost_currency')
})
