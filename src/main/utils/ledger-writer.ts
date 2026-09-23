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
  const staged = await stageLedgerChecked(deps, content)
  if (!staged.ok) return staged
  commitStagedLedger(deps.ledgerPath)
  return { ok: true }
}

/**
 * 只写 tmp + 校验，**不动原文件**（M11 多文件合并的第一阶段）。
 *
 * 多文件合并必须两阶段落盘：先把所有文件（账本 + 各 JSON）校验通过，再统一替换，
 * 否则账本校验失败时 JSON 已经写坏——半写状态比不写更糟。
 */
export async function stageLedgerChecked(
  deps: LedgerWriterDeps,
  content: string
): Promise<WriteCheckedResult> {
  const tmpPath = `${deps.ledgerPath}.tmp`
  rmSync(tmpPath, { force: true }) // 清理崩溃残留（best-effort）
  writeFileSync(tmpPath, content, 'utf8')
  let parsed: Awaited<ReturnType<PythonSvc['parseEntries']>>
  try {
    parsed = await deps.engine.parseEntries(tmpPath)
  } catch (err) {
    // 引擎 RPC 失败时 parseEntries 是 **throw**（进程缺失 ENOENT / 方法不存在 -32601 / 超时），
    // 不像账本校验错误那样返回 errors。这里不删，tmp 就永久留在账本目录——M14 实测踩到过：
    // 一条 2.4MB 的 main.beancount.tmp 躺了两天（.gitignore 里有 *.beancount.tmp，所以同步不受影响）。
    // 下一行那只在文件开头 best-effort 的 rmSync 才是自愈点，但它要等到**下一次成功保存**。
    rmSync(tmpPath, { force: true })
    throw err
  }
  if (parsed.errors.length > 0) {
    rmSync(tmpPath, { force: true })
    return { ok: false, message: parsed.errors.map((e) => e.message).join('; ') }
  }
  return { ok: true }
}

/** 第二阶段：把已校验的 tmp 原子替换为正式文件 */
export function commitStagedLedger(ledgerPath: string): void {
  renameSync(`${ledgerPath}.tmp`, ledgerPath)
}
