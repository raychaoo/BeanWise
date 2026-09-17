/**
 * JSON 配置文件的安全落盘（M11）：写 `${filePath}.tmp` → parse + 结构化校验 →
 * renameSync 原子替换；校验失败删 tmp、原文件不动。
 * 与 utils/ledger-writer.ts 同口径（校验失败不落盘，比写后回滚干净）。
 *
 * 注意：写入的是调用方给定的**最终文本**（合并引擎已规范化），本函数不做任何重新序列化——
 * 否则「两侧内容一致」的快速前进会因格式重排而产生无谓差异。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonWriteResult {
  ok: boolean
  message?: string
}

/**
 * @param validate 结构化校验（解析 + 逐条 normalize），抛出即视为非法
 */
export function writeJsonChecked(filePath: string, content: string, validate: (text: string) => void): JsonWriteResult {
  const tmp = `${filePath}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tmp, content, 'utf8')
    validate(content)
    renameSync(tmp, filePath)
    return { ok: true }
  } catch (err) {
    rmSync(tmp, { force: true })
    return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
  }
}
