/**
 * 明细视图（M4；批次 B 瘦身 + 时间筛选）：页头 = 时间快捷筛选（Segmented + RangePicker，前端过滤
 * 已加载分页数据，Tooltip 说明能力边界）+「重建索引」（e2e/ledger-index.spec.ts 依赖页头按钮）。
 * 日期列默认倒序。索引状态卡与「清空账本」本批原样保留（迁移至设置页归批次 D 收口）。
 */
import { DeleteOutlined, QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  message,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { useMemo, useState } from 'react'
import type { LedgerEntryRow } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'
import { formatAmount } from '../utils/format'
import '../styles/views/entries.less'

const PAGE_SIZE = 20

const STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

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

/** 数值展示（条目数/错误数）：走 formatAmount 统一千分位，空值 '—' */
function formatCount(n: number | undefined): string {
  return formatAmount(n === undefined ? null : String(n))
}

export default function EntriesView() {
  const status = useLedgerStore((s) => s.status)
  const entries = useLedgerStore((s) => s.entries)
  const total = useLedgerStore((s) => s.total)
  const loading = useLedgerStore((s) => s.loading)
  const error = useLedgerStore((s) => s.error)
  const refresh = useLedgerStore((s) => s.refresh)
  const loadEntries = useLedgerStore((s) => s.loadEntries)
  const setError = useLedgerStore((s) => s.setError)
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const [page, setPage] = useState(1)
  const [clearing, setClearing] = useState(false)
  const [quick, setQuick] = useState<QuickKey>('all')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | null>(null)

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
      // YYYY-MM-DD 字典序即时间序；默认倒序（最新在前）
      sorter: (a, b) => a.date.localeCompare(b.date),
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
    }
  ]

  /** 重建索引 → 重拉状态与条目（M3 refreshIndex 管线） */
  const handleRefreshIndex = async () => {
    try {
      await window.beanwise.refreshLedgerIndex()
    } catch (err) {
      setError(String(err))
    }
    await refresh()
  }

  const handleClear = () => {
    Modal.confirm({
      title: '清空账本',
      content: '将删除账本中的所有交易记录与账户 open 记录，账户设置会保留。此操作不可撤销。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setClearing(true)
        try {
          const result = typeof window.beanwise.clearLedger === 'function'
            ? await window.beanwise.clearLedger()
            : await clearViaSaveFile()
          if (result.ok) {
            message.success('账本已清空')
            setPage(1)
            await refresh()
            await useLedgerStore.getState().loadAccounts()
          } else {
            message.error(result.message ?? '清空失败')
          }
        } catch (err) {
          message.error(String(err))
        } finally {
          setClearing(false)
        }
      }
    })
  }

  /** 旧版 preload 没有 clearLedger 时，复用读取 + 整文件覆盖保存清空账本。 */
  const clearViaSaveFile = async () => {
    const read = await window.beanwise.readLedgerFile()
    if (!read.ok || !read.fingerprint) throw new Error(read.message ?? '读取账本失败')
    return window.beanwise.saveLedgerFile({ content: '', expectedFingerprint: read.fingerprint })
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
          <Tooltip title="筛选作用于已加载分页数据；全量时间筛选需索引查询支持（超 UI 层 #2）">
            <QuestionCircleOutlined className="entries-filter-hint" />
          </Tooltip>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void handleRefreshIndex()}>
          重建索引
        </Button>
      </div>
      <Card title="索引状态" className="entries-status-card" extra={
        <Button danger icon={<DeleteOutlined />} loading={clearing} onClick={handleClear}>清空账本</Button>
      }>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="路径">{status?.path ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={STATUS_COLOR[status?.status ?? 'missing']}>{status?.status ?? 'missing'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="条目数"><span className="num">{formatCount(status?.entryCount)}</span></Descriptions.Item>
          <Descriptions.Item label="错误数"><span className="num">{formatCount(status?.errorCount)}</span></Descriptions.Item>
          <Descriptions.Item label="更新时间" span={2}>
            {status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—'}
          </Descriptions.Item>
          {status?.lastError && (
            <Descriptions.Item label="最近错误" span={2}>
              <span className="error-text">{status.lastError}</span>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>
      <Card title={`条目（${shownTotal}）`}>
        <Table<LedgerEntryRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={filteredEntries}
          columns={columns}
          pagination={{
            pageSize: PAGE_SIZE,
            total: shownTotal,
            current: page,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => {
              setPage(p)
              void loadEntries(PAGE_SIZE, (p - 1) * PAGE_SIZE)
            }
          }}
        />
      </Card>
    </div>
  )
}
