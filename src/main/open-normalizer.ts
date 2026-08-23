/**
 * 导入前把账本中本次用到的账户 open 日期校正到「本次最早交易日期」之前。
 *
 * 流水按时间倒序，旧账本 open 日期可能晚于历史交易日期；Beancount 对
 * 交易日期早于 open 日期的账户报 inactive。这里把已存在的 open 提前，缺失的补上。
 */

const OPEN_RE = /^(\d{4}-\d{2}-\d{2})\s+open\s+(\S+)/

/**
 * 返回校正后的账本内容：所有用到的账户 open 日期不晚于 minDate；
 * 缺失 open 的账户补在末尾（追加交易块之前）。
 */
export function normalizeAccountOpens(
  content: string,
  accounts: readonly string[],
  minDate: string
): string {
  const used = new Set(accounts)
  const present = new Set<string>()
  const lines = content.split('\n')
  const updated = lines.map((line) => {
    const m = OPEN_RE.exec(line)
    if (m && used.has(m[2])) {
      present.add(m[2])
      if (m[1] > minDate) {
        return line.replace(/^\d{4}-\d{2}-\d{2}/, minDate)
      }
    }
    return line
  }).join('\n')

  const missing = accounts.filter((a) => !present.has(a))
  const additions = missing.map((a) => `${minDate} open ${a}`).join('\n')
  const body = updated.replace(/\n+$/, '')
  return body === ''
    ? additions === ''
      ? '\n'
      : `${additions}\n`
    : additions === ''
      ? `${body}\n`
      : `${body}\n${additions}\n`
}
