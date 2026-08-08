import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzle, openDatabase } from './index'
import { entries, ledgerMeta, postings } from './schema'

describe('SQLite 索引层（M3）', () => {
  let db: ReturnType<typeof openDatabase>

  beforeAll(() => {
    db = openDatabase(':memory:')
  })
  afterAll(() => {
    db.close()
  })

  it('建表后三张表可用，单行 meta 写入读取往返', () => {
    const drizzle = createDrizzle(db)
    drizzle.insert(ledgerMeta).values({
      id: 1,
      ledgerPath: '/tmp/main.beancount',
      status: 'ok',
      entryCount: 5,
      updatedAt: 123
    }).run()
    const row = drizzle.select().from(ledgerMeta).get()
    expect(row?.ledgerPath).toBe('/tmp/main.beancount')
    expect(row?.status).toBe('ok')
  })

  it('entries + postings 写入与级联删除', () => {
    const drizzle = createDrizzle(db)
    const entry = drizzle
      .insert(entries)
      .values({ type: 'Transaction', date: '2026-01-02', payee: 'Breakfast', lineno: 8 })
      .returning()
      .get()
    drizzle.insert(postings).values({
      entryId: entry.id,
      account: 'Assets:Bank:CNB',
      unitsNumber: '-15.00',
      unitsCurrency: 'CNY'
    }).run()

    const rows = drizzle
      .select()
      .from(postings)
      .where((t) => eq(t.entryId, entry.id))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0].unitsNumber).toBe('-15.00')

    drizzle.delete(entries).where(eq(entries.id, entry.id)).run()
    expect(
      drizzle.select().from(postings).where((t) => eq(t.entryId, entry.id)).all()
    ).toHaveLength(0) // FK cascade 生效
  })

  it('date 索引按时间序查询', () => {
    const drizzle = createDrizzle(db)
    drizzle.insert(entries).values([
      { type: 'Open', date: '2026-01-01', account: 'Assets:Bank:CNB' },
      { type: 'Open', date: '2026-01-03', account: 'Expenses:Food' }
    ]).run()
    const ordered = drizzle.select().from(entries).orderBy(desc(entries.date)).all()
    expect(ordered[0].date).toBe('2026-01-03')
  })
})
