import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, truncateSync } from 'node:fs'
import { dirname } from 'node:path'
import { computeBalancingNumber } from '../../../shared/decimal'
import type { AddEntryResult, ClearLedgerResult, ListAccountsResult, ListEntriesParams, ReadFileResult, RefreshResult, SaveFileParams, SaveFileResult } from '../../../shared/ipc'
import type { DrizzleDb } from '../../db/index'
import { postings } from '../../db/schema'
import { findUnopenedAccounts, serializeEntry, serializeFirstEntryBlock, serializeOpenLines, validateEntryParams } from '../../core/entry-serializer'
import { getLedgerStatus, listEntries, refreshIndex } from '../../core/index-builder'
import { writeLedgerChecked } from '../../utils/ledger-writer'
import type { PythonSvc } from '../../core/python-svc'
import { withWriteLock } from '../../utils/write-lock'

/** 可注入的 IPC 注册器（测试传 mock，主进程传 electron.ipcMain） */
export interface IpcRegistrar {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
}

export interface LedgerDeps {
  db: DrizzleDb
  engine: PythonSvc
  /** 账本文件路径（主进程持有，渲染进程不传路径——防目录穿越） */
  ledgerPath: string
}

const MAX_LIMIT = 1_000
const DEFAULT_LIMIT = 100

/** 提取账本 option 行（title/operating_currency 等配置）；无 option → ''。清空账本时保留。 */
function extractOptionLines(content: string): string {
  const options = content.split('\n').filter((l) => /^option\s+/.test(l))
  return options.length > 0 ? options.join('\n') + '\n' : ''
}

/** 读账本全文；文件不存在 → ''（clear 保留 option 用）。 */
function readLedgerText(ledgerPath: string): string {
  try {
    return readFileSync(ledgerPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/** 文件末字节是否为换行；空文件视为「是」——追加首个文本块时避免前导空行 */
function fileEndsWithLf(path: string, size: number): boolean {
  if (size === 0) return true
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validateListParams(params: unknown): {
  limit: number
  offset: number
  order: 'asc' | 'desc'
  dateFrom?: string
  dateTo?: string
  keyword?: string
  account?: string
} {
  const raw = (params ?? {}) as Partial<ListEntriesParams>
  if (raw.limit !== undefined && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_LIMIT)) {
    throw new Error(`limit 必须是 1~${MAX_LIMIT} 的整数`)
  }
  if (raw.offset !== undefined && (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0)) {
    throw new Error('offset 必须是非负整数')
  }
  if (raw.order !== undefined && raw.order !== 'asc' && raw.order !== 'desc') {
    throw new Error('order 必须是 asc 或 desc')
  }
  if (raw.dateFrom !== undefined && (typeof raw.dateFrom !== 'string' || !ISO_DATE_RE.test(raw.dateFrom))) {
    throw new Error('dateFrom 必须是 YYYY-MM-DD 日期')
  }
  if (raw.dateTo !== undefined && (typeof raw.dateTo !== 'string' || !ISO_DATE_RE.test(raw.dateTo))) {
    throw new Error('dateTo 必须是 YYYY-MM-DD 日期')
  }
  if (raw.keyword !== undefined && (typeof raw.keyword !== 'string' || raw.keyword.length > 200)) {
    throw new Error('keyword 必须是不超过 200 字的字符串')
  }
  const keyword = raw.keyword?.trim() || undefined
  return {
    limit: raw.limit ?? DEFAULT_LIMIT,
    offset: raw.offset ?? 0,
    order: raw.order ?? 'asc',
    dateFrom: raw.dateFrom,
    dateTo: raw.dateTo,
    keyword,
    // 透传给 listEntries 校验（非空字符串、长度上限 200 在查询函数内单点把关）
    account: raw.account
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/
const MAX_LEDGER_CONTENT_BYTES = 20 * 1024 * 1024

function validateSaveParams(raw: unknown): SaveFileParams {
  const p = (raw ?? {}) as Partial<SaveFileParams>
  if (typeof p.content !== 'string') throw new Error('content 必须是字符串')
  if (Buffer.byteLength(p.content, 'utf8') > MAX_LEDGER_CONTENT_BYTES) {
    throw new Error('账本内容超过 20MB 上限')
  }
  if (typeof p.expectedFingerprint !== 'string' || !SHA256_RE.test(p.expectedFingerprint)) {
    throw new Error('expectedFingerprint 必须是 64 位小写 sha256 hex')
  }
  return { content: p.content, expectedFingerprint: p.expectedFingerprint }
}

/**
 * 双写互斥说明（M5 终审，实现抽取至 write-lock.ts）：
 * add-entry 与 save-file 写通道串行化（任一时刻至多一个写者，sync 域复用同一把锁）。
 * 防时序：save 指纹比对通过（磁盘=F1）→ 写 tmp → parse 校验（百毫秒）期间 add-entry 完成
 * append（F1+E）→ save renameSync 原子覆盖 → 录入笔 E 从唯一事实源静默消失，两 UI 均报成功。
 * 错误不污染队列：本次失败仅影响调用方，下一次任务照常排队。
 */

/** 账户列表（postings 表 DISTINCT，上限 500）——ledger:list-accounts 与 ai:parse 共享（M7-T3 抽取） */
export function listAccounts(db: DrizzleDb): string[] {
  return db
    .selectDistinct({ account: postings.account })
    .from(postings)
    .orderBy(postings.account)
    .limit(500)
    .all()
    .map((r) => r.account)
}

/** 注册 ledger 域 IPC 通道（roadmap「IPC 契约」：类型唯一来源 ipc.ts → preload 白名单 → main handler） */
export function registerLedgerHandlers(ipc: IpcRegistrar, deps: LedgerDeps): void {
  ipc.handle('ledger:refresh-index', async (): Promise<RefreshResult> => {
    return refreshIndex(deps.db, deps.engine, deps.ledgerPath)
  })

  ipc.handle('ledger:status', () => {
    return getLedgerStatus(deps.db)
  })

  // async 而非同步返回：校验抛错转为 rejected promise，测试与 ipcMain.handle 语义一致
  // （ipcMain.handle 对同步 throw 同样转为 invoke 拒绝，两者对调用方无差别）
  ipc.handle('ledger:list-entries', async (_event: unknown, params: unknown) => {
    const { limit, offset, order, dateFrom, dateTo, keyword, account } = validateListParams(params)
    return listEntries(deps.db, limit, offset, order, { dateFrom, dateTo, keyword, account })
  })

  // M4：录入一笔交易。数据流铁律（先落文件 → 校验 → 重建索引）：
  // validateEntryParams 前置校验 → 借贷平衡校验 → 追加写文件 → refreshIndex（M3 管线）
  // → 索引 error（理论上仅前置校验漏网）truncate 回滚
  ipc.handle('ledger:add-entry', (_event: unknown, raw: unknown): Promise<AddEntryResult> =>
    withWriteLock(async () => {
    const params = validateEntryParams(raw)

    // 借贷平衡校验（精确十进制加法，禁 parseFloat/Number）
    const diff = computeBalancingNumber(params.postings.map((p) => p.number))
    if (diff !== '0') {
      throw new Error(`借贷不平衡：差额 ${diff}`)
    }

    // 追加写：末字节非换行则先补 \n；首文件（ENOENT）自动创建（目录一并创建，
    // 并补交易账户 open 行——beancount 未 open 账户报 ValidationError，2026-08-09 实测）
    let preLength = 0
    try {
      const stat = statSync(deps.ledgerPath)
      if (stat.size === 0) {
        // 工作目录打开时会先创建空账本；空文件也要走首笔骨架，否则交易账户没有 open。
        appendFileSync(deps.ledgerPath, serializeFirstEntryBlock(params), 'utf8')
      } else {
        const endsWithLf = fileEndsWithLf(deps.ledgerPath, stat.size)
        preLength = stat.size + (endsWithLf ? 0 : 1)
        // 追加场景：自动补的反向分录账户（如 Equity:AutoBalance）可能尚未 open，
        // 需在交易前补 open 行，否则 Beancount 报 unknown account。
        const content = readFileSync(deps.ledgerPath, 'utf8')
        const unopened = findUnopenedAccounts(content, params.postings.map((p) => p.account))
        const openLines = serializeOpenLines(params.date, unopened)
        appendFileSync(deps.ledgerPath, (endsWithLf ? '' : '\n') + openLines + serializeEntry(params), 'utf8')
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      mkdirSync(dirname(deps.ledgerPath), { recursive: true })
      appendFileSync(deps.ledgerPath, serializeFirstEntryBlock(params), 'utf8')
    }

    // 校验 + 索引重建；失败回滚文件（回滚失败记日志，留 M5 手工修复）
    const result = await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
    if (result.status === 'error') {
      try {
        truncateSync(deps.ledgerPath, preLength)
      } catch (rollbackErr) {
        console.error('[BeanWise] 录入回滚失败（文件保留，待 M5 手工修复）:', rollbackErr)
      }
      return {
        ok: false,
        message: result.message,
        status: result.status,
        entryCount: result.entryCount,
        errorCount: result.errorCount
      }
    }
    return { ok: true, status: result.status, entryCount: result.entryCount, errorCount: result.errorCount }
  }))

  // M4：账户列表（录入表单 AutoComplete 数据源，postings 表 DISTINCT）
  ipc.handle('ledger:list-accounts', (): ListAccountsResult => ({
    accounts: listAccounts(deps.db)
  }))

  // M5：读账本全文（渲染端编辑基线；ENOENT → ok:false，编辑器 Empty 态）
  ipc.handle('ledger:read-file', (): ReadFileResult => {
    try {
      // M5 终审：同一 buffer 哈希——两次读取间文件被改写会返回自相矛盾快照
      // （基线=旧内容、指纹=新文件 → 保存时本应报冲突的修改被静默覆盖）
      const content = readFileSync(deps.ledgerPath, 'utf8')
      const fingerprint = createHash('sha256').update(content).digest('hex')
      return { ok: true, content, fingerprint }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, message: '账本文件不存在，请先在录入视图录一笔创建' }
      }
      throw err
    }
  })

  // M5：整文件覆盖保存——指纹比对（外部修改冲突检测）→ 共享落盘管线（writeLedgerChecked：
  // 写 .tmp → parse 校验 → rename 原子替换）→ 索引重建。校验失败不落盘（tmp 删除、原文件不动），
  // 比 M4 append 的「写后 truncate 回滚」更干净
  ipc.handle('ledger:save-file', (_event: unknown, raw: unknown): Promise<SaveFileResult> =>
    withWriteLock(async () => {
    const { content, expectedFingerprint } = validateSaveParams(raw)

    // 1. 外部修改冲突检测：同一次读取的快照（内容 + 指纹），无二次读取竞态
    let diskContent: string
    try {
      diskContent = readFileSync(deps.ledgerPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('账本文件不存在')
      throw err
    }
    const diskFingerprint = createHash('sha256').update(diskContent).digest('hex')
    if (diskFingerprint !== expectedFingerprint) {
      return { ok: false, conflict: true, diskContent, diskFingerprint }
    }

    // 2. 共享落盘管线（M6 抽取，合并/接管复用）：校验失败不落盘、返回错误文案
    const written = await writeLedgerChecked(deps, content)
    if (!written.ok) return { ok: false, message: written.message }

    // 3. 索引重建（M3 管线）
    const result = await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
    return {
      ok: true,
      // M5 终审：rename 后第三读改内存哈希——写入文件的正是 content，无需再读盘
      fingerprint: createHash('sha256').update(content).digest('hex'),
      status: result.status,
      entryCount: result.entryCount,
      errorCount: result.errorCount,
      ...(result.status === 'error' ? { message: result.message } : {})
    }
  }))

  // 清空账本：复用共享落盘管线（tmp 校验 → rename 原子替换）→ 索引重建。
  // 账户设置保留，只清账本文本（交易 + open 记录）；option 行（title/operating_currency）
  // 一并保留——否则清空重录/导入后运营货币丢失，报表图表恒空（2026-08-23 回归修复）。
  ipc.handle('ledger:clear', (): Promise<ClearLedgerResult> =>
    withWriteLock(async () => {
      const current = readLedgerText(deps.ledgerPath)
      const written = await writeLedgerChecked(deps, extractOptionLines(current))
      if (!written.ok) return { ok: false, message: written.message }
      const result = await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
      return {
        ok: true,
        status: result.status,
        entryCount: result.entryCount,
        errorCount: result.errorCount,
        ...(result.status === 'error' ? { message: result.message } : {})
      }
    }))
}
