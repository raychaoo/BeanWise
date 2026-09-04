import { describe, expect, it } from 'vitest'
import {
  BEANWISE_FP_MARKER,
  computeDedupFingerprint,
  extractBeanwiseFingerprintCounts,
  fingerprintMarker,
  normalizeCounterparty,
  normalizeFingerprintAmount
} from './dedup'

describe('computeDedupFingerprint（跨来源去重指纹）', () => {
  it('稳定且确定：同一交易在不同来源得到相同指纹', () => {
    const wechat = computeDedupFingerprint('2026-08-21', '麦当劳', '17.4', 'expense')
    const bank = computeDedupFingerprint('2026-08-21', '麦当劳', '17.40', 'expense')
    expect(wechat).toBe('5dafb0225fbfc5fc')
    expect(bank).toBe(wechat)
  })

  it('忽略对方名称空白与金额小数尾巴', () => {
    expect(normalizeCounterparty(' 麦当劳 ')).toBe('麦当劳')
    expect(normalizeFingerprintAmount('17.40')).toBe('17.4')
    expect(normalizeFingerprintAmount('17')).toBe('17')
    expect(computeDedupFingerprint('2026-08-21', ' 麦当劳 ', '17.40', 'expense')).toBe(
      computeDedupFingerprint('2026-08-21', '麦当劳', '17.4', 'expense')
    )
  })

  it('方向/金额/对方任一不同 → 指纹不同', () => {
    const base = computeDedupFingerprint('2026-08-21', '杜永奇', '15', 'expense')
    expect(computeDedupFingerprint('2026-08-21', '杜永奇', '15', 'income')).not.toBe(base)
    expect(computeDedupFingerprint('2026-08-21', '杜永奇', '16', 'expense')).not.toBe(base)
    expect(computeDedupFingerprint('2026-08-21', '张三', '15', 'expense')).not.toBe(base)
  })
})

describe('指纹标记与提取', () => {
  it('fingerprintMarker 与 extractBeanwiseFingerprintCounts 配对并计数', () => {
    const fp = computeDedupFingerprint('2026-08-21', '麦当劳', '17.4', 'expense')
    const content =
      '2026-08-21 * "麦当劳" "麦当劳"\n  Expenses:Shopping  17.4 CNY\n  Assets:C  -17.4 CNY\n' +
      fingerprintMarker(fp) +
      '\n' +
      '2026-08-22 * "麦当劳" "麦当劳"\n  Expenses:Shopping  17.4 CNY\n  Assets:C  -17.4 CNY\n' +
      fingerprintMarker(fp) +
      '\n' +
      '; beanwise-import: test-src:A1\n' +
      '; wechat-pay-id: TX001\n'
    expect(fingerprintMarker(fp)).toBe(`; ${BEANWISE_FP_MARKER}: ${fp}`)
    const counts = extractBeanwiseFingerprintCounts(content)
    expect(counts.get(fp)).toBe(2)
    expect([...counts.entries()]).toHaveLength(1)
    expect(extractBeanwiseFingerprintCounts('; beanwise-import: x\n; wechat-pay-id: y').size).toBe(0)
  })
})
