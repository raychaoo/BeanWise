/**
 * 明细视图（M4；批次 B 瘦身 + 时间筛选；批次 D 迁出索引状态卡与「清空账本」至设置页）：
 * 页头 = 时间快捷筛选（Segmented + RangePicker，前端过滤已加载分页数据，Tooltip 说明能力边界）
 * +「重建索引」（e2e/ledger-index.spec.ts 依赖页头按钮）。
 * 数据策略（总体排序）：列表为标准服务端分页查询——后端按 order（默认 desc，最新在前）对全库
 * ORDER BY date,id 后 LIMIT/OFFSET，翻页/列头排序切换均重新查询，排序天然作用于总体数据。
 */
import { QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Segmented,
  Table,
  Tooltip
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import type { LedgerEntryRow } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'
import '../styles/views/entries.less'

const PAGE_SIZE = 20

type QuickKey = 'today' | 'week' | '7d' | 'month' | 'all'

const QUICK_OPTIONS: Array<{ label: string; value: QuickKey }> = [
  { label: '今日', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '近7天', value: '7d' },
  { label: '本月', value: 'month' },
  { label: '全部', value: 'all' }
]

/** 快捷段 → [起, 止]（含端点，按日粒度）；'all' → null 不过滤 */
function quickRange(key: QuickKey): [Dayjs, Dayjs] | null {
  const now = dayjs()
  switch (key) {
    case 'today':
      return [now.startOf('day'), now.endOf('day')]
    case 'week':
      return [now.startOf('week'), now.endOf('week')]
    case '7d':
      return [now.subtract(6, 'day').startOf('day'), now.endOf('day')]
    case 'month':
      return [now.startOf('month'), now.endOf('month')]
    case 'all':
      return null
  }
}

/** 日期（YYYY-MM-DD）是否落在 [起, 止] 内（按日粒度，仅用 dayjs 核心方法，零插件依赖） */
function dateInRange(date: string, range: [Dayjs, Dayjs] | null): boolean {
  if (!range) return true
  const d = dayjs(date)
  return !d.isBefore(range[0], 'day') && !d.isAfter(range[1], 'day')
}

export default function EntriesView() {
  const entries = useLedgerStore((s) => s.entries)
  const total = useLedgerStore((s) => s.total)
  const loading = useLedgerStore((s) => s.loading)
  const error = useLedgerStore((s) => s.error)
  const refresh = useLedgerStore((s) => s.refresh)
  const loadEntries = useLedgerStore((s) => s.loadEntries)
  const setError = useLedgerStore((s) => s.setError)
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const [page, setPage] = useState(1)
  const [quick, setQuick] = useState<QuickKey>('all')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | null>(null)
  // 日期列服务端排序方向（受控）：切换 = 改查询参数重查后端，而非本地排当前页
  const [dateOrder, setDateOrder] = useState<'ascend' | 'descend'>('descend')

  // 挂载拉第一页（dateOrder 初始恒为 descend → desc）：分页查询语义，entries 归位为当前页数据
  useEffect(() => {
    void loadEntries(PAGE_SIZE, 0, 'desc')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeRange = custom ?? quickRange(quick)
  const filtering = activeRange !== null
  const filteredEntries = useMemo(
    () => (activeRange ? entries.filter((e) => dateInRange(e.date, activeRange)) : entries),
    [entries, activeRange]
  )
  const shownTotal = filtering ? filteredEntries.length : total

  /** 切换筛选后回第一页：分页数据是后端按页拉取的，过滤只作用于当前已加载页 */
  const handleQuick = (key: string) => {
    setQuick(key as QuickKey)
    setCustom(null)
    setPage(1)
  }

  const handleCustom = (dates: [Dayjs | null, Dayjs | null] | null) => {
    const valid = dates && dates[0] && dates[1] ? ([dates[0], dates[1]] as [Dayjs, Dayjs]) : null
    setCustom(valid)
    if (valid) setQuick('all')
    setPage(1)
  }

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))

  const columns: ColumnsType<LedgerEntryRow> = [
    {
      title: '日期',
      dataIndex: 'date',
      width: 110,
      // 服务端排序：ORDER BY date,id 由后端执行；sorter: true 仅提供列头交互，不本地排序
      sorter: true,
      sortOrder: dateOrder
    },
    { title: '标志', dataIndex: 'flag', width: 60, render: (v: string | null) => v ?? '—' },
    { title: '类型', dataIndex: 'type', width: 90 },
    { title: '交易对象', dataIndex: 'payee', render: (v: string | null) => v ?? '—' },
    { title: '说明', dataIndex: 'narration', render: (v: string | null) => v ?? '—' },
    {
      title: '账户',
      dataIndex: 'account',
      render: (v: string | null) => {
        if (!v) return '—'
        const label = accountNameMap.get(v) ?? v
        return label === v ? v : <Tooltip title={v}>{label}</Tooltip>
      }
    }
  ]

  /** 重建索引 → 重拉状态与第一页（M3 refreshIndex 管线）；索引状态与「清空账本」已迁设置页 */
  const handleRefreshIndex = async () => {
    try {
      await window.beanwise.refreshLedgerIndex()
    } catch (err) {
      setError(String(err))
    }
    setPage(1)
    await refresh()
    await loadEntries(PAGE_SIZE, 0, dateOrder === 'descend' ? 'desc' : 'asc')
  }

  return (
    <div className="entries-view">
      {error && (
        <Alert type="error" message={error} showIcon closable onClose={() => setError(null)} className="entries-error" />
      )}
      <div className="entries-toolbar">
        <div className="entries-filter">
          <Segmented options={QUICK_OPTIONS} value={quick} onChange={handleQuick} />
          <DatePicker.RangePicker value={custom} onChange={handleCustom} placeholder={['开始日期', '结束日期']} />
          <Tooltip title="排序为全库排序（服务端执行）；筛选作用于已加载分页数据，全量时间筛选需索引查询支持（超 UI 层 #2）">
            <QuestionCircleOutlined className="entries-filter-hint" />
          </Tooltip>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void handleRefreshIndex()}>
          重建索引
        </Button>
      </div>
      <Card title={`条目（${shownTotal}）`}>
        <Table<LedgerEntryRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={filteredEntries}
          columns={columns}
          onChange={(_pagination, _filters, sorter) => {
            const s = Array.isArray(sorter) ? sorter[0] : sorter
            if (s && (s.order === 'ascend' || s.order === 'descend') && s.order !== dateOrder) {
              setDateOrder(s.order)
              setPage(1)
              void loadEntries(PAGE_SIZE, 0, s.order === 'descend' ? 'desc' : 'asc')
            }
          }}
          pagination={{
            pageSize: PAGE_SIZE,
            total: shownTotal,
            current: page,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => {
              setPage(p)
              void loadEntries(PAGE_SIZE, (p - 1) * PAGE_SIZE, dateOrder === 'descend' ? 'desc' : 'asc')
            }
          }}
        />
      </Card>
    </div>
  )
}
