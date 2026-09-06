/**
 * 现金流量表（批次 G #7）：报告式上下结构——期间选择（粒度 Select + 起止年 Select，复用
 * reports store 的 availableYears；本地 state 保持与趋势页独立）+ 顶部固定说明行
 * 「口径：Assets 组全部账户视为资金池」+ 期间/流入/流出/净额表格（.num 右对齐，负数红）。
 * 数据经 report:cash-flow 主进程聚合（Assets 资金池口径：池内互转不计，按运营货币计，
 * 金额全链路 decimal 字符串）。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { Alert, Empty, Select, Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { CashFlowPoint, ReportGranularity } from '../../../../shared/ipc'
import { useReportsStore } from '../../stores/reports'
import { formatAmount } from '../../utils/format'

const GRANULARITY_OPTIONS: Array<{ label: string; value: ReportGranularity }> = [
  { label: '日', value: 'day' },
  { label: '周', value: 'week' },
  { label: '月', value: 'month' },
  { label: '年', value: 'year' }
]

const PAGE_SIZE = 12

/** 金额单元格：千分位 + .num 右对齐，负数红（红色语义唯一化） */
function NumCell({ value }: { value: string }) {
  return <span className={`num${value.startsWith('-') ? ' num-negative' : ''}`}>{formatAmount(value)}</span>
}

export default function CashFlowTable() {
  // 本地期间 state（与趋势页独立，互不干扰）；起止年下拉选项复用 reports store 的 availableYears
  const availableYears = useReportsStore((s) => s.availableYears)
  const [granularity, setGranularity] = useState<ReportGranularity>('month')
  const [startYear, setStartYear] = useState<number | null>(null)
  const [endYear, setEndYear] = useState<number | null>(null)
  const [series, setSeries] = useState<CashFlowPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const dateFrom = startYear !== null ? `${startYear}-01-01` : undefined
    const dateTo = endYear !== null ? `${endYear}-12-31` : undefined
    window.beanwise
      .getCashFlowReport({ granularity, dateFrom, dateTo })
      .then((r) => {
        if (!cancelled) setSeries(r.series)
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [granularity, startYear, endYear])

  const yearOptions = (() => {
    if (!availableYears || availableYears.max <= 0) return []
    const options: Array<{ label: string; value: number }> = []
    for (let y = availableYears.min; y <= availableYears.max; y++) options.push({ label: `${y}年`, value: y })
    return options
  })()
  const yearSelectDisabled = yearOptions.length === 0

  const columns: ProColumns<CashFlowPoint>[] = [
    { title: '期间', dataIndex: 'period', width: 140 },
    { title: '流入', dataIndex: 'inflow', align: 'right', render: (_dom: unknown, row: CashFlowPoint) => <NumCell value={row.inflow} /> },
    { title: '流出', dataIndex: 'outflow', align: 'right', render: (_dom: unknown, row: CashFlowPoint) => <NumCell value={row.outflow} /> },
    { title: '净额', dataIndex: 'net', align: 'right', render: (_dom: unknown, row: CashFlowPoint) => <NumCell value={row.net} /> }
  ]

  return (
    <div>
      <div className="report-sheet__head">
        <Typography.Text strong>现金流量表</Typography.Text>
        <Select
          aria-label="报表粒度"
          value={granularity}
          style={{ width: 96 }}
          options={GRANULARITY_OPTIONS}
          onChange={(v) => setGranularity(v)}
        />
        <Select
          aria-label="起始年"
          placeholder="起始年"
          allowClear
          style={{ width: 110 }}
          value={startYear ?? undefined}
          options={yearOptions}
          onChange={(v) => setStartYear(v ?? null)}
          disabled={yearSelectDisabled}
        />
        <Typography.Text type="secondary">至</Typography.Text>
        <Select
          aria-label="结束年"
          placeholder="结束年"
          allowClear
          style={{ width: 110 }}
          value={endYear ?? undefined}
          options={yearOptions}
          onChange={(v) => setEndYear(v ?? null)}
          disabled={yearSelectDisabled}
        />
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="口径：Assets 组全部账户视为资金池（个人记账语境假设），池内互转不计，按运营货币计"
      />
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <Spin spinning={loading}>
        <ProTable<CashFlowPoint>
          size="small"
          rowKey="period"
          dataSource={series}
          columns={columns}
          pagination={{
            defaultPageSize: PAGE_SIZE,
            pageSizeOptions: ['12', '24', '50'],
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 期`
          }}
          locale={{ emptyText: <Empty description="暂无现金流量数据" /> }}
          search={false}
          options={false}
        />
      </Spin>
    </div>
  )
}
