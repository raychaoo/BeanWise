import { renameSync, rmSync, writeFileSync } from 'node:fs'
import type { PythonSvc } from '../core/python-svc'

export interface LedgerWriterDeps {
  ledgerPath: string
  engine: PythonSvc
}

/** 合并/接管内容落盘结果 */
export interface WriteCheckedResult {
  ok: boolean
  message?: string
}

/**
 * M5 save 管线核心抽取（M6 合并/接管复用）：写同目录 tmp → parse_entries 校验 →
 * 通过 rename 原子替换（校验失败删 tmp、原文件不动——校验失败不落盘，比写后回滚干净）。
 * 调用方负责包 withWriteLock 与后续 refreshIndex。
 */
export async function writeLedgerChecked(
  deps: LedgerWriterDeps,
  content: string
): Promise<WriteCheckedResult> {
  const tmpPath = `${deps.ledgerPath}.tmp`
  rmSync(tmpPath, { force: true }) // 清理崩溃残留（best-effort）
  writeFileSync(tmpPath, content, 'utf8')
  const parsed = await deps.engine.parseEntries(tmpPath)
  if (parsed.errors.length > 0) {
    rmSync(tmpPath, { force: true })
    return { ok: false, message: parsed.errors.map((e) => e.message).join('; ') }
  }
  renameSync(tmpPath, deps.ledgerPath)
  return { ok: true }
}
