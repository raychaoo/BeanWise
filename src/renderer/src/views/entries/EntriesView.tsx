/**
 * 明细视图（M4；批次 B 瘦身；批次 D 迁出索引状态卡与「清空账本」至设置页）：
 * 页头 = 时间快捷筛选（Segmented）+ 自定义范围（RangePicker）+ 关键词搜索 +「重建索引」
 * （e2e/ledger-index.spec.ts 依赖页头按钮）。
 * 数据策略（超 UI 层 #2 落地）：筛选/搜索/排序全部为服务端查询参数——后端对全库 WHERE +
 * ORDER BY date,id 后 LIMIT/OFFSET 分页返回，total 同条件计数；排序方向（正/倒序）由日期列头
 * 切换，翻页/筛选/搜索/排序变化均重新查询，天然作用于总体数据。
 */
import { QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, DatePicker, Input, Segmented, Table, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import type { LedgerEntryRow, ListEntriesFilters } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import { formatAmount } from '../../utils/format'
import '../../styles/views/entries.less'

const PAGE_SIZE = 20

type QuickKey = 'today' | 'week' | '7d' | 'month' | 'all'

const QUICK_OPTIONS: Array<{ label: string; value: QuickKey }> = [
  { label: '今日', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '近7天', value: '7d' },
  { label: '本月', value: 'month' },
  { label: '全部', value: 'all' }
]

/** 快捷段 → [起, 止]（含端点，YYYY-MM-DD）；'all' → null 不过滤（周起始随 zh-cn locale 为周一） */
function quickRange(key: QuickKey): [string, string] | null {
  const now = dayjs()
  switch (key) {
    case 'today':
      return [now.format('YYYY-MM-DD'), now.format('YYYY-MM-DD')]
    case 'week':
      return [now.startOf('week').format('YYYY-MM-DD'), now.endOf('week').format('YYYY-MM-DD')]
    case '7d':
      return [now.subtract(6, 'day').format('YYYY-MM-DD'), now.format('YYYY-MM-DD')]
    case 'month':
      return [now.startOf('month').format('YYYY-MM-DD'), now.endOf('month').format('YYYY-MM-DD')]
    case 'all':
      return null
  }
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
  // 已应用的搜索词（Input.Search 回车/按钮触发，避免逐键查询）
  const [appliedKeyword, setAppliedKeyword] = useState('')
  // 日期列服务端排序方向（受控）：切换 = 改查询参数重查后端，而非本地排当前页
  const [dateOrder, setDateOrder] = useState<'ascend' | 'descend'>('descend')

  /** 当前筛选状态 → 服务端过滤参数（quick 与自定义范围互斥：custom 优先） */
  const filtersOf = (q: QuickKey, c: [Dayjs, Dayjs] | null, keyword: string): ListEntriesFilters => {
    const range: [string, string] | null = c
      ? [c[0].format('YYYY-MM-DD'), c[1].format('YYYY-MM-DD')]
      : quickRange(q)
    return {
      ...(range ? { dateFrom: range[0], dateTo: range[1] } : {}),
      ...(keyword.trim() ? { keyword: keyword.trim() } : {})
    }
  }

  const runQuery = (p: number, order: 'ascend' | 'descend', filters: ListEntriesFilters) => {
    void loadEntries({
      limit: PAGE_SIZE,
      offset: (p - 1) * PAGE_SIZE,
      order: order === 'descend' ? 'desc' : 'asc',
      ...filters
    })
  }

  // 挂载拉第一页（dateOrder 初始恒为 descend → desc）
  useEffect(() => {
    void loadEntries({ limit: PAGE_SIZE, offset: 0, order: 'desc' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 任何筛选变化后回第一页重新查询 */
  const handleQuick = (key: string) => {
    const q = key as QuickKey
    setQuick(q)
    setCustom(null)
    setPage(1)
    runQuery(1, dateOrder, filtersOf(q, null, appliedKeyword))
  }

  const handleCustom = (dates: [Dayjs | null, Dayjs | null] | null) => {
    const valid = dates && dates[0] && dates[1] ? ([dates[0], dates[1]] as [Dayjs, Dayjs]) : null
    setCustom(valid)
    if (valid) setQuick('all')
    setPage(1)
    runQuery(1, dateOrder, filtersOf(valid ? 'all' : quick, valid, appliedKeyword))
  }

  const handleSearch = (raw: string) => {
    setAppliedKeyword(raw.trim())
    setPage(1)
    runQuery(1, dateOrder, filtersOf(quick, custom, raw))
  }

  /** allowClear 点 × 清空不触发 onSearch：这里补一次清空重查 */
  const handleSearchChange = (raw: string) => {
    if (raw === '' && appliedKeyword !== '') handleSearch('')
  }

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))

  const columns: ColumnsType<LedgerEntryRow> = [
    {
      title: '日期',
      dataIndex: 'date',
      width: 110,
      // 服务端排序（非受控）：antd 管理列头轮换（默认 descend 起），onChange 给出真实 next 方向，
      // 此处按新方向重查后端；受控 sortOrder + sorter:true 组合下点击只会发出空 sorter（实测），不可用
      sorter: true,
      defaultSortOrder: 'descend'
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
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      // 交易金额（超 UI 层 #1）：资产流视角（收入 +、支出 -），千分位 + 负数红；转账/Open 行无金额
      render: (v: string | null, row) =>
        v === null ? (
          '—'
        ) : (
          <span className={`num${v.startsWith('-') ? ' num-negative' : ''}`}>
            {formatAmount(v)}
            {row.currency ? ` ${row.currency}` : ''}
          </span>
        )
    }
  ]

  /** 重建索引 → 重拉状态与当前条件第一页（M3 refreshIndex 管线）；索引状态与「清空账本」已迁设置页 */
  const handleRefreshIndex = async () => {
    try {
      await window.beanwise.refreshLedgerIndex()
    } catch (err) {
      setError(String(err))
    }
    setPage(1)
    await refresh()
    runQuery(1, dateOrder, filtersOf(quick, custom, appliedKeyword))
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
          <Input.Search
            allowClear
            className="entries-search"
            placeholder="搜索交易对象 / 说明 / 账户"
            onSearch={handleSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          <Tooltip title="筛选、搜索与排序均为全库查询（服务端执行，翻页取数）">
            <QuestionCircleOutlined className="entries-filter-hint" />
          </Tooltip>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void handleRefreshIndex()}>
          重建索引
        </Button>
      </div>
      <Card title={`条目（${total}）`}>
        <Table<LedgerEntryRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={entries}
          columns={columns}
          onChange={(_pagination, _filters, sorter) => {
            const s = Array.isArray(sorter) ? sorter[0] : sorter
            if (s?.field === 'date' && (s.order === 'ascend' || s.order === 'descend') && s.order !== dateOrder) {
              setDateOrder(s.order)
              setPage(1)
              runQuery(1, s.order, filtersOf(quick, custom, appliedKeyword))
            }
          }}
          pagination={{
            pageSize: PAGE_SIZE,
            total,
            current: page,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => {
              setPage(p)
              runQuery(p, dateOrder, filtersOf(quick, custom, appliedKeyword))
            }
          }}
        />
      </Card>
    </div>
  )
}
