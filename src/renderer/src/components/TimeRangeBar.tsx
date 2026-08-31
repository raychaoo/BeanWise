/**
 * 统一时间筛选条（批次 D Task 1）：快捷段 Segmented + RangePicker 自定义 + 可选报表口径
 * 粒度 Segmented（月/年）。showPresets=false 时仅粒度 + 自定义范围（Dashboard 趋势卡形态）。
 * 受控组件：value/onChange 由 useTimeRange 提供，状态不落组件内部。
 */
import { DatePicker, Segmented, Space } from 'antd'
import type { Dayjs } from 'dayjs'
import { presetRange } from '../hooks/useTimeRange'
import type { TimeGranularity, TimePreset, TimeRangeValue } from '../hooks/useTimeRange'

const PRESET_OPTIONS: Array<{ label: string; value: TimePreset }> = [
  { label: '今日', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '近7天', value: '7d' },
  { label: '本月', value: 'month' },
  { label: '全部', value: 'all' }
]

const GRANULARITY_OPTIONS: Array<{ label: string; value: TimeGranularity }> = [
  { label: '日', value: 'day' },
  { label: '周', value: 'week' },
  { label: '月', value: 'month' },
  { label: '年', value: 'year' }
]

interface Props {
  value: TimeRangeValue
  onChange(value: TimeRangeValue): void
  showPresets?: boolean
  showGranularity?: boolean
}

export default function TimeRangeBar({ value, onChange, showPresets = true, showGranularity = false }: Props) {
  const picker = showGranularity && value.granularity === 'year' ? 'year' : showGranularity ? 'month' : undefined

  return (
    <Space size={8} wrap className="time-range-bar">
      {showPresets && (
        <Segmented
          options={PRESET_OPTIONS}
          value={value.preset}
          onChange={(v) => {
            if (typeof v !== 'string') return
            const preset = v as TimePreset
            onChange({ ...value, preset, range: presetRange(preset) })
          }}
        />
      )}
      {showGranularity && (
        <Segmented
          options={GRANULARITY_OPTIONS}
          value={value.granularity}
          onChange={(v) => {
            if (typeof v !== 'string') return
            // 粒度切换后原范围精度不再匹配（月范围 ≠ 年范围），重置为「全部」
            onChange({ ...value, granularity: v as TimeGranularity, preset: 'all', range: null })
          }}
        />
      )}
      <DatePicker.RangePicker
        picker={picker}
        value={value.range}
        allowClear
        placeholder={showGranularity ? ['起始', '结束'] : ['开始日期', '结束日期']}
        onChange={(dates) => {
          const range = dates && dates[0] && dates[1] ? ([dates[0], dates[1]] as [Dayjs, Dayjs]) : null
          onChange({ ...value, preset: range ? 'custom' : 'all', range })
        }}
      />
    </Space>
  )
}
