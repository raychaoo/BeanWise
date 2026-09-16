/**
 * 明细视图（M4；批次 B 瘦身；批次 D 迁出索引状态卡与「清空账本」至设置页）：
 * 页头 = 时间快捷筛选（Segmented）+ 自定义范围（RangePicker）+ 关键词搜索 + 金额搜索（独立
 * InputNumber，不与文本搜索混用）+「重建索引」（e2e/ledger-index.spec.ts 依赖页头按钮）。
 * 数据策略（超 UI 层 #2 落地）：筛选/搜索/排序全部为服务端查询参数——后端对全库 WHERE +
 * ORDER BY date,id 后 LIMIT/OFFSET 分页返回，total 同条件计数；排序方向（正/倒序）由日期列头
 * 切换，翻页/筛选/搜索/排序变化均重新查询，天然作用于总体数据。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { EditOutlined, QuestionCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Card, DatePicker, Input, InputNumber, Segmented, Tooltip, Typography } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import type { LedgerEntryRow, ListEntriesFilters } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import '../../styles/views/entries.less'
import AmountCell from './AmountCell'
import EntryEditDrawer from './EntryEditDrawer'
import { accountDisplay } from './entryRowDisplay'

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
  const [quick, setQuick] = useState<QuickKey>('all')
  const [custom, setCustom] = useState<[Dayjs, Dayjs] | null>(null)
  // 已应用的搜索词（Input.Search 回车/按钮触发，避免逐键查询）
  const [appliedKeyword, setAppliedKeyword] = useState('')
  // 金额搜索：输入值（受控）与已应用值分开，同 keyword——回车/点搜索才查询
  const [amountInput, setAmountInput] = useState('')
  const [appliedAmount, setAppliedAmount] = useState('')
  // 日期列服务端排序方向（受控）：切换 = 改查询参数重查后端，而非本地排当前页
  const [dateOrder, setDateOrder] = useState<'ascend' | 'descend'>('descend')
  // ProTable 管理的页码（筛选/排序变化时重置为 1）
  const [page, setPage] = useState(1)
  const [editEntryId, setEditEntryId] = useState<string | null>(null)

  /** 当前筛选状态 → 服务端过滤参数（quick 与自定义范围互斥：custom 优先） */
  const filtersOf = (
    q: QuickKey,
    c: [Dayjs, Dayjs] | null,
    keyword: string,
    amount: string
  ): ListEntriesFilters => {
    const range: [string, string] | null = c
      ? [c[0].format('YYYY-MM-DD'), c[1].format('YYYY-MM-DD')]
      : quickRange(q)
    const amt = amount.trim()
    return {
      ...(range ? { dateFrom: range[0], dateTo: range[1] } : {}),
      ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      ...(amt ? { amount: amt } : {})
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
    runQuery(1, dateOrder, filtersOf(q, null, appliedKeyword, appliedAmount))
  }

  const handleCustom = (dates: [Dayjs | null, Dayjs | null] | null) => {
    const valid = dates && dates[0] && dates[1] ? ([dates[0], dates[1]] as [Dayjs, Dayjs]) : null
    setCustom(valid)
    if (valid) setQuick('all')
    setPage(1)
    runQuery(1, dateOrder, filtersOf(valid ? 'all' : quick, valid, appliedKeyword, appliedAmount))
  }

  const handleSearch = (raw: string) => {
    setAppliedKeyword(raw.trim())
    setPage(1)
    runQuery(1, dateOrder, filtersOf(quick, custom, raw, appliedAmount))
  }

  /** allowClear 点 × 清空不触发 onSearch：这里补一次清空重查 */
  const handleSearchChange = (raw: string) => {
    if (raw === '' && appliedKeyword !== '') handleSearch('')
  }

  /** 金额框回车 / 点搜索图标：落为查询参数（服务端按绝对值精确匹配，与文本搜索互不干扰） */
  const handleAmount = (raw: string) => {
    const amt = raw.trim()
    setAppliedAmount(amt)
    setPage(1)
    runQuery(1, dateOrder, filtersOf(quick, custom, appliedKeyword, amt))
  }

  /** InputNumber 无 allowClear，删空即 onChange(null)：等同取消金额筛选的一次重查 */
  const handleAmountChange = (raw: string | null) => {
    const next = raw ?? ''
    setAmountInput(next)
    if (next.trim() === '' && appliedAmount !== '') {
      setAppliedAmount('')
      setPage(1)
      runQuery(1, dateOrder, filtersOf(quick, custom, appliedKeyword, ''))
    }
  }

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))
  /** 账户路径 → 账户库中文名（无映射回落路径本身） */
  const nameOf = (value: string): string => accountNameMap.get(value) ?? value

  const columns: ProColumns<LedgerEntryRow>[] = [
    {
      title: '日期',
      dataIndex: 'date',
      width: 110,
      // 服务端排序（非受控）：antd 管理列头轮换（默认 descend 起），onChange 给出真实 next 方向，
      // 此处按新方向重查后端；受控 sortOrder + sorter:true 组合下点击只会发出空 sorter（实测），不可用
      sorter: true,
      defaultSortOrder: 'descend'
    },
    {
      title: '时间',
      dataIndex: 'time',
      width: 170,
      render: (_dom: unknown, row: LedgerEntryRow) => row.time ?? '—'
    },
    {
      title: 'ID',
      dataIndex: 'externalId',
      width: 210,
      render: (_dom: unknown, row: LedgerEntryRow) =>
        row.externalId ? (
          <Typography.Text code copyable={{ text: row.externalId }} ellipsis={{ tooltip: row.externalId }}>
            {row.externalId}
          </Typography.Text>
        ) : (
          '—'
        )
    },
    { title: '标志', dataIndex: 'flag', width: 60, render: (_dom: unknown, row: LedgerEntryRow) => row.flag ?? '—' },
    { title: '类型', dataIndex: 'type', width: 90 },
    {
      title: '交易对象',
      dataIndex: 'payee',
      render: (_dom: unknown, row: LedgerEntryRow) => <span className="entries-cell">{row.payee ?? '—'}</span>
    },
    {
      title: '说明',
      dataIndex: 'narration',
      render: (_dom: unknown, row: LedgerEntryRow) => <span className="entries-cell">{row.narration ?? '—'}</span>
    },
    {
      title: '账户',
      dataIndex: 'account',
      render: (_dom: unknown, row: LedgerEntryRow) => {
        // 取数口径见 entryRowDisplay.accountDisplay：损益类目 / 账内搬移流向串 / Open 条目账户
        const cell = accountDisplay(row, nameOf)
        if (!cell) return '—'
        // 搬移账户串可较长（多腿）：限宽换行保列宽，hover 另给完整路径
        return (
          <Tooltip title={cell.raw}>
            <span className="entries-account">{cell.label}</span>
          </Tooltip>
        )
      }
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 150,
      // 交易金额（超 UI 层 #1）：损益额取资产流视角（收入 +、支出 -），账内搬移显发生额；
      // 着色与文字标签按 txKind（主进程算的交易类型）——借出是正数，靠正负号无法着色。
      // 原对账明细账各自写了一遍这个渲染且漏了兜底分支，故收到 AmountCell 里单源
      render: (_dom: unknown, row: LedgerEntryRow) => <AmountCell row={row} />
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      fixed: 'right',
      render: (_dom: unknown, row: LedgerEntryRow) =>
        row.externalId ? (
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            aria-label={`编辑 ${row.externalId}`}
            onClick={() => setEditEntryId(row.externalId)}
          >
            编辑
          </Button>
        ) : (
          '—'
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
    runQuery(1, dateOrder, filtersOf(quick, custom, appliedKeyword, appliedAmount))
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
          {/* 金额搜索独立成框（不与文本搜索混在一起）：服务端按绝对值精确匹配，回车或点图标生效 */}
          <InputNumber
            stringMode
            controls={false}
            className="entries-amount-search"
            placeholder="金额"
            value={amountInput}
            onChange={handleAmountChange}
            onPressEnter={() => handleAmount(amountInput)}
          />
          <Tooltip title="按金额搜索（回车同效）">
            <Button icon={<SearchOutlined />} aria-label="按金额搜索" onClick={() => handleAmount(amountInput)} />
          </Tooltip>
          <Tooltip title="筛选、搜索与排序均为全库查询（服务端执行，翻页取数）；金额搜索按绝对值精确匹配，忽略正负与小数尾零">
            <QuestionCircleOutlined className="entries-filter-hint" />
          </Tooltip>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void handleRefreshIndex()}>
          重建索引
        </Button>
      </div>
      <Card title={`条目（${total}）`}>
        <ProTable<LedgerEntryRow>
          rowKey={(row) => row.externalId ?? String(row.id)}
          size="small"
          loading={loading}
          dataSource={entries}
          columns={columns}
          onChange={(_pagination, _filters, sorter) => {
            const s = Array.isArray(sorter) ? sorter[0] : sorter
            if (s?.field === 'date' && (s.order === 'ascend' || s.order === 'descend') && s.order !== dateOrder) {
              setDateOrder(s.order)
              setPage(1)
              runQuery(1, s.order, filtersOf(quick, custom, appliedKeyword, appliedAmount))
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
              runQuery(p, dateOrder, filtersOf(quick, custom, appliedKeyword, appliedAmount))
            }
          }}
          search={false}
          options={false}
        />
      </Card>
      <EntryEditDrawer
        open={editEntryId !== null}
        entryId={editEntryId}
        onClose={() => setEditEntryId(null)}
        onSaved={() => {
          setPage(1)
          runQuery(1, dateOrder, filtersOf(quick, custom, appliedKeyword, appliedAmount))
        }}
      />
    </div>
  )
}
