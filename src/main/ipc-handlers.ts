import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { computeBalancingNumber } from '../shared/decimal'
import type { AddEntryResult, ListAccountsResult, ListEntriesParams, ReadFileResult, RefreshResult, SaveFileParams, SaveFileResult } from '../shared/ipc'
import type { DrizzleDb } from './db'
import { postings } from './db/schema'
import { serializeEntry, serializeFirstEntryBlock, validateEntryParams } from './entry-serializer'
import { getLedgerStatus, listEntries, refreshIndex, sha256File } from './index-builder'
import type { PythonSvc } from './python-svc'

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

function validateListParams(params: unknown): { limit: number; offset: number } {
  const raw = (params ?? {}) as Partial<ListEntriesParams>
  if (raw.limit !== undefined && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_LIMIT)) {
    throw new Error(`limit 必须是 1~${MAX_LIMIT} 的整数`)
  }
  if (raw.offset !== undefined && (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0)) {
    throw new Error('offset 必须是非负整数')
  }
  return {
    limit: raw.limit ?? DEFAULT_LIMIT,
    offset: raw.offset ?? 0
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
    const { limit, offset } = validateListParams(params)
    return listEntries(deps.db, limit, offset)
  })

  // M4：录入一笔交易。数据流铁律（先落文件 → 校验 → 重建索引）：
  // validateEntryParams 前置校验 → 借贷平衡校验 → 追加写文件 → refreshIndex（M3 管线）
  // → 索引 error（理论上仅前置校验漏网）truncate 回滚
  ipc.handle('ledger:add-entry', async (_event: unknown, raw: unknown): Promise<AddEntryResult> => {
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
      const endsWithLf = fileEndsWithLf(deps.ledgerPath, stat.size)
      preLength = stat.size + (endsWithLf ? 0 : 1)
      appendFileSync(deps.ledgerPath, (endsWithLf ? '' : '\n') + serializeEntry(params), 'utf8')
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
  })

  // M4：账户列表（录入表单 AutoComplete 数据源，postings 表 DISTINCT）
  ipc.handle('ledger:list-accounts', (): ListAccountsResult => {
    const rows = deps.db
      .selectDistinct({ account: postings.account })
      .from(postings)
      .orderBy(postings.account)
      .limit(500)
      .all()
    return { accounts: rows.map((r) => r.account) }
  })

  // M5：读账本全文（渲染端编辑基线；ENOENT → ok:false，编辑器 Empty 态）
  ipc.handle('ledger:read-file', (): ReadFileResult => {
    try {
      const content = readFileSync(deps.ledgerPath, 'utf8')
      return { ok: true, content, fingerprint: sha256File(deps.ledgerPath) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, message: '账本文件不存在，请先在录入视图录一笔创建' }
      }
      throw err
    }
  })

  // M5：整文件覆盖保存——指纹比对（外部修改冲突检测）→ 写 tmp → parse 校验 → rename 原子替换
  // → 索引重建。校验失败不落盘（tmp 删除、原文件不动），比 M4 append 的「写后 truncate 回滚」更干净
  ipc.handle('ledger:save-file', async (_event: unknown, raw: unknown): Promise<SaveFileResult> => {
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

    // 2. 写同目录临时文件 → parse 校验（引擎无状态，tmp 路径合法）
    const tmpPath = `${deps.ledgerPath}.m5tmp`
    rmSync(tmpPath, { force: true }) // 清理上次崩溃残留（best-effort）
    writeFileSync(tmpPath, content, 'utf8')
    const parsed = await deps.engine.parseEntries(tmpPath)
    if (parsed.errors.length > 0) {
      rmSync(tmpPath, { force: true })
      return { ok: false, message: parsed.errors.map((e) => e.message).join('; ') }
    }

    // 3. rename 原子替换（Node on Windows：覆盖已存在文件）→ 索引重建（M3 管线）
    renameSync(tmpPath, deps.ledgerPath)
    const result = await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
    return {
      ok: true,
      fingerprint: sha256File(deps.ledgerPath),
      status: result.status,
      entryCount: result.entryCount,
      errorCount: result.errorCount,
      ...(result.status === 'error' ? { message: result.message } : {})
    }
  })
}
