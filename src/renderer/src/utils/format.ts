/**
 * 金额千分位格式化（方案 2.3）：纯字符串处理防精度丢失，禁 Number/parseFloat。
 * 消费方：BalanceHint 差额展示、EntriesView 数值展示（批次 B）；后续 D 批总览/对账页复用。
 */

/** '1234567.89' → '1,234,567.89'；负数原样带符号；空值/非法返回 '—' */
export function formatAmount(raw: string | null | undefined): string {
  if (!raw || !/^-?\d+(\.\d+)?$/.test(raw.trim())) return '—'
  const neg = raw.startsWith('-') ? '-' : ''
  const [int, frac] = raw.replace(/^-/, '').split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg}${grouped}${frac ? '.' + frac : ''}`
}
