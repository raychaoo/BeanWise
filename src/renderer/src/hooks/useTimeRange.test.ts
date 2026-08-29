/**
 * useTimeRange 纯函数测试（批次 D Task 1）：preset → [起, 止] 边界。
 * vitest 为 node 环境（无 jsdom），hook 本体仅组合 presetRange + useState（薄层，
 * 由 typecheck/e2e 回归），此处覆盖计划钉死的边界：'7d' end=今天 / start=6 天前零点；
 * 'week' start=本周一。
 */
import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { presetRange } from './useTimeRange'

describe('presetRange（快捷段 → 时间范围）', () => {
  it("'today'：当日零点至当日结束", () => {
    const range = presetRange('today')
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(start.isSame(dayjs().startOf('day'), 'millisecond')).toBe(true)
    expect(end.isSame(dayjs().endOf('day'), 'millisecond')).toBe(true)
  })

  it("'week'：start 为本周一（isoWeek，周一为一周起点，不依赖 locale）", () => {
    const range = presetRange('week')
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(start.isoWeekday()).toBe(1)
    expect(start.isSame(dayjs().startOf('isoWeek'), 'day')).toBe(true)
    expect(end.isSame(dayjs().endOf('isoWeek'), 'day')).toBe(true)
  })

  it("'7d'：end 为今天、start 为 6 天前零点", () => {
    const range = presetRange('7d')
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(end.isSame(dayjs(), 'day')).toBe(true)
    expect(start.isSame(dayjs().subtract(6, 'day'), 'day')).toBe(true)
    expect(start.hour()).toBe(0)
    expect(start.minute()).toBe(0)
    expect(start.second()).toBe(0)
  })

  it("'month'：本月一日起", () => {
    const range = presetRange('month')
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(start.date()).toBe(1)
    expect(start.isSame(dayjs().startOf('month'), 'day')).toBe(true)
    expect(end.isSame(dayjs().endOf('month'), 'day')).toBe(true)
  })

  it("'custom'/'all'：null（custom 存于 hook 的 range 字段，all 不过滤）", () => {
    expect(presetRange('custom')).toBeNull()
    expect(presetRange('all')).toBeNull()
  })
})
