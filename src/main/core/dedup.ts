/**
 * 跨来源去重（M10）：全局内容指纹。
 *
 * rowId 是「来源内身份」（source:rowId，同模板重导/区间重叠用）；指纹是「交易本身的
 * 身份」——由 日期|金额|对方|方向 归一化后哈希，不含来源/单号/支付方式，因此同类流水
 * 与银行卡流水里同一笔交易能互相识别。指纹策略「宁漏勿误」：对不上的允许重复导入，
 * 绝不因匹配过宽误删真实交易。
 */
import { createHash } from 'node:crypto'

export const BEANWISE_FP_MARKER = 'beanwise-fp'

/** 对方名称归一化：去空白（跨来源常见差异，如「美团」 vs 「美团 」）。 */
export function normalizeCounterparty(text: string): string {
  return text.trim().replace(/\s+/g, '')
}

/** 金额归一化：去掉小数尾巴，使 17.4 与 17.40 等价。 */
export function normalizeFingerprintAmount(amount: string): string {
  const s = amount.trim()
  if (s.includes('.')) return s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

/** 计算跨来源去重指纹（sha256 截断 16 位十六进制）。date 为 YYYY-MM-DD（忽略时分秒）。 */
export function computeDedupFingerprint(
  date: string,
  counterparty: string,
  amount: string,
  kind: 'expense' | 'income' | 'neutral'
): string {
  return createHash('sha256')
    .update(`${date}|${normalizeCounterparty(counterparty)}|${normalizeFingerprintAmount(amount)}|${kind}`)
    .digest('hex')
    .slice(0, 16)
}

/** 指纹标记行文本。 */
export function fingerprintMarker(fingerprint: string): string {
  return `; ${BEANWISE_FP_MARKER}: ${fingerprint}`
}

/** 从账本内容提取各指纹出现次数（Map<fingerprint, count>），供「1 对 1 / 多对多」判定。 */
export function extractBeanwiseFingerprintCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>()
  const re = new RegExp(`^;\\s*${BEANWISE_FP_MARKER}:\\s*(\\S+)\\s*$`, 'gm')
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  return counts
}
