/**
 * 统一时间范围 hook（批次 D Task 1，方案模块 2「图表筛选统一」）：快捷段 + 自定义范围 +
 * 报表口径粒度（月/年）三态合一，Dashboard 趋势卡与流水类页面共用，杜绝各图表各自为政。
 * preset→range 计算抽为纯函数 presetRange（node 单测覆盖边界，同 EntryFormView
 * nextBalancingNumber 模式）；hook 本体仅做状态组合。
 */
import dayjs, { type Dayjs } from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek'
import { useState } from 'react'
import type { ReportGranularity } from '../../../shared/ipc'

// 'week' 以周一为一周起点：isoWeek 插件不依赖运行环境 locale（dayjs 默认 en 周日起）
dayjs.extend(isoWeek)

export type TimePreset = 'today' | 'week' | '7d' | 'month' | 'custom' | 'all'

/** 报表口径粒度（批次 G：随 ReportGranularity 放开日/周，超 UI 层 #4 落地） */
export type TimeGranularity = ReportGranularity

export interface TimeRangeValue {
  preset: TimePreset
  /** [起, 止] 含端点；null = 不过滤（全部） */
  range: [Dayjs, Dayjs] | null
  /** 报表口径粒度（TimeRangeBar showGranularity 时维护） */
  granularity: TimeGranularity
}

/** 快捷段 → [起, 止]（含端点）；'custom'/'all' → null（custom 存于 value.range，all 不过滤） */
export function presetRange(preset: TimePreset): [Dayjs, Dayjs] | null {
  const now = dayjs()
  switch (preset) {
    case 'today':
      return [now.startOf('day'), now.endOf('day')]
    case 'week':
      return [now.startOf('isoWeek'), now.endOf('isoWeek')]
    case '7d':
      return [now.subtract(6, 'day').startOf('day'), now.endOf('day')]
    case 'month':
      return [now.startOf('month'), now.endOf('month')]
    case 'custom':
    case 'all':
      return null
  }
}

export function useTimeRange(initial?: Partial<TimeRangeValue>) {
  const [value, setValue] = useState<TimeRangeValue>({
    preset: 'all',
    range: null,
    granularity: 'month',
    ...initial
  })

  const setPreset = (preset: TimePreset): void => {
    setValue((v) => ({ ...v, preset, range: presetRange(preset) }))
  }

  const setCustomRange = (range: [Dayjs, Dayjs] | null): void => {
    setValue((v) => ({ ...v, preset: 'custom', range }))
  }

  const setGranularity = (granularity: TimeGranularity): void => {
    // 粒度切换后原范围精度不再匹配（月范围 ≠ 年范围），重置为「全部」
    setValue((v) => ({ ...v, granularity, preset: 'all', range: null }))
  }

  return { preset: value.preset, range: value.range, granularity: value.granularity, setPreset, setCustomRange, setGranularity }
}
