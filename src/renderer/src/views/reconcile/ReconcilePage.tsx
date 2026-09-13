/**
 * 对账页：Tab① 三栏式科目余额表（批次 G #5：report:trial-balance，期初/发生/期末，
 * 每账户每币种一行；顶部日期 RangePicker → dateFrom/dateTo；币种 CheckableTag 筛选）
 * + Tab② 明细账（批次 F）：账户 TreeSelect（五大类分组）→ listEntries 服务端 account
 * 精确过滤 + 金额/交易对象/说明关键词 + order desc 分页查询；显示稳定 ID 与秒级交易时间，
 * 复用 EntryEditDrawer 按 ID 编辑。本地查询状态（不经共享 store entries 槽，防跨页串扰）。
 * 金额 formatAmount 千分位 + .num 右对齐，负数 .num-negative（红色语义唯一化）。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { EditOutlined } from '@ant-design/icons'
import { Alert, Button, DatePicker, Empty, Input, Space, Spin, Tabs, Tag, Tooltip, TreeSelect, Typography } from 'antd'
import type { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LedgerEntryRow, ListEntriesFilters, ReportTrialBalanceParams, TrialBalanceCell, TrialBalanceRow } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import type { AccountOption } from '../../stores/ledger'
import { formatAmount } from '../../utils/format'
import EntryEditDrawer from '../entries/EntryEditDrawer'
import '../../styles/views/reconcile.less'

/** 三栏单元格：金额千分位 + 币种，右对齐（.num），负数红（.num-negative） */
function TrialBalanceCellView({ cell }: { cell: TrialBalanceCell }) {
  return (
    <span className={`num${cell.number.startsWith('-') ? ' num-negative' : ''}`}>
      {formatAmount(cell.number)} {cell.currency}
    </span>
  )
}


/** 账户顶层五大类中文分组（TreeSelect 组节点不可选，value 加前缀防与真实账户撞值） */
const TOP_CATEGORY_LABELS: Record<string, string> = {
  Assets: '资产',
  Liabilities: '负债',
  Equity: '权益',
  Income: '收入',
  Expenses: '支出'
}

function buildAccountTree(options: AccountOption[]) {
  const groups = new Map<string, AccountOption[]>()
  for (const o of options) {
    const top = o.value.split(':')[0] ?? ''
    const list = groups.get(top)
    if (list) list.push(o)
    else groups.set(top, [o])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([top, items]) => {
      const label = TOP_CATEGORY_LABELS[top] ?? top
      return {
        title: label,
        value: `__group__${top}`,
        label,
        selectable: false,
        children: items.map((o) => ({ title: o.label, value: o.value, label: o.label }))
      }
    })
}

const DETAIL_PAGE_SIZE = 20

/** 明细账 Tab（批次 F）：单一账户的服务端分页查询，选择即查，切换账户重置页码 */
function DetailLedgerTab() {
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const accountTree = useMemo(() => buildAccountTree(accountOptions), [accountOptions])
  const accountNameMap = useMemo(() => new Map(accountOptions.map((o) => [o.value, o.label])), [accountOptions])

  const [account, setAccount] = useState<string | undefined>(undefined)
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [rows, setRows] = useState<LedgerEntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [appliedKeyword, setAppliedKeyword] = useState('')
  const [editEntryId, setEditEntryId] = useState<string | null>(null)

  const loadEntries = useCallback(async (acc: string, p: number, r: [Dayjs, Dayjs] | null, keyword: string) => {
    setLoading(true)
    setError(null)
    try {
      const filters: ListEntriesFilters = {
        ...(r ? { dateFrom: r[0].format('YYYY-MM-DD'), dateTo: r[1].format('YYYY-MM-DD') } : {}),
        ...(keyword ? { keyword } : {})
      }
      const r2 = await window.beanwise.listLedgerEntries({
        account: acc,
        order: 'desc',
        limit: DETAIL_PAGE_SIZE,
        offset: (p - 1) * DETAIL_PAGE_SIZE,
        ...filters
      })
      setRows(r2.entries)
      setTotal(r2.total)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 选择/清空账户：清空回到引导空态（不做全库查询——本 Tab 语义为单账户明细流） */
  const handleSelect = (value: string | undefined) => {
    setAccount(value)
    setPage(1)
    setRows([])
    setTotal(0)
    if (value) void loadEntries(value, 1, range, appliedKeyword)
  }

  const handleRange = (dates: [Dayjs | null, Dayjs | null] | null) => {
    const valid = dates && dates[0] && dates[1] ? ([dates[0], dates[1]] as [Dayjs, Dayjs]) : null
    setRange(valid)
    setPage(1)
    if (account) void loadEntries(account, 1, valid, appliedKeyword)
  }

  const handleSearch = (raw: string) => {
    const keyword = raw.trim()
    setAppliedKeyword(keyword)
    setPage(1)
    if (account) void loadEntries(account, 1, range, keyword)
  }

  const handleSearchChange = (raw: string) => {
    if (raw === '' && appliedKeyword !== '') handleSearch('')
  }

  const handlePageChange = (p: number) => {
    setPage(p)
    if (account) void loadEntries(account, p, range, appliedKeyword)
  }

  const accountLabel = account ? (accountNameMap.get(account) ?? account) : null

  const columns: ProColumns<LedgerEntryRow>[] = [
    {
      title: 'ID',
      dataIndex: 'externalId',
      width: 220,
      render: (_dom: unknown, row: LedgerEntryRow) =>
        row.externalId ? (
          <Typography.Text code copyable={{ text: row.externalId }} ellipsis={{ tooltip: row.externalId }}>
            {row.externalId}
          </Typography.Text>
        ) : (
          '—'
        )
    },
    {
      title: '交易时间',
      dataIndex: 'time',
      width: 180,
      render: (_dom: unknown, row: LedgerEntryRow) => row.time ?? `${row.date} 00:00:00`
    },
    { title: '交易对象', dataIndex: 'payee', render: (_dom: unknown, row: LedgerEntryRow) => row.payee ?? '—', ellipsis: true },
    { title: '说明', dataIndex: 'narration', render: (_dom: unknown, row: LedgerEntryRow) => row.narration ?? '—', ellipsis: true },
    {
      title: '账户',
      dataIndex: 'account',
      // 服务端精确过滤后每行均属所选账户：中文映射 + Tooltip 原名
      render: (_dom: unknown, row: LedgerEntryRow) => {
        const v = row.account
        return accountLabel === null
          ? '—'
          : accountLabel === v
            ? v
            : <Tooltip title={v}>{accountLabel}</Tooltip>
      }
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      // 交易金额（超 UI 层 #1）：资产流视角（收入 +、支出 -），千分位 + 负数红；转账/Open 行无金额
      render: (_dom: unknown, row: LedgerEntryRow) =>
        row.amount === null ? '—' : <span className={`num${row.amount.startsWith('-') ? ' num-negative' : ''}`}>{formatAmount(row.amount)}</span>
    },
    { title: '币种', dataIndex: 'currency', width: 80, render: (_dom: unknown, row: LedgerEntryRow) => row.currency ?? '—' },
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

  return (
    <>
      <div className="reconcile-toolbar reconcile-detail-toolbar">
        <TreeSelect
          showSearch
          allowClear
          treeDefaultExpandAll
          value={account}
          treeData={accountTree}
          treeNodeFilterProp="label"
          placeholder="选择账户"
          style={{ minWidth: 280 }}
          onChange={handleSelect}
        />
        <DatePicker.RangePicker
          allowClear
          value={range}
          placeholder={['起始日期', '结束日期']}
          onChange={handleRange}
        />
        <Input.Search
          allowClear
          className="reconcile-detail-search"
          placeholder="搜索金额 / 交易对象 / 说明"
          onSearch={handleSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
        <Button type="primary" disabled={!account} onClick={() => handleSearch(appliedKeyword)}>
          查询
        </Button>
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <ProTable<LedgerEntryRow>
        rowKey={(row) => row.externalId ?? String(row.id)}
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        locale={{
          emptyText: <Empty description={account ? '该账户暂无分录' : '选择账户后查看其明细分录'} />
        }}
        pagination={{
          pageSize: DETAIL_PAGE_SIZE,
          total,
          current: page,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条`,
          onChange: handlePageChange
        }}
        search={false}
        options={false}
      />
      <EntryEditDrawer
        open={editEntryId !== null}
        entryId={editEntryId}
        onClose={() => setEditEntryId(null)}
        onSaved={() => {
          if (account) return loadEntries(account, page, range, appliedKeyword)
        }}
      />
    </>
  )
}

export default function ReconcilePage() {
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [rows, setRows] = useState<TrialBalanceRow[]>([])
  const [currencyFilter, setCurrencyFilter] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (r: [Dayjs, Dayjs] | null) => {
    setLoading(true)
    setError(null)
    try {
      // 三栏口径：dateFrom = 区间起点（opening 为之前累计），dateTo = 区间终点
      const params: ReportTrialBalanceParams = r
        ? { dateFrom: r[0].format('YYYY-MM-DD'), dateTo: r[1].format('YYYY-MM-DD') }
        : {}
      const res = await window.beanwise.getTrialBalanceReport(params)
      setRows(res.rows)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(range)
  }, [load, range])

  // 币种筛选：Tag 从当前数据派生；筛选币种随数据消失时自动退化为「全部」（防空表困惑）
  const currencies = useMemo(() => [...new Set(rows.map((r) => r.opening.currency))].sort(), [rows])
  const effectiveFilter = currencyFilter !== null && currencies.includes(currencyFilter) ? currencyFilter : null
  const visibleRows = effectiveFilter === null ? rows : rows.filter((r) => r.opening.currency === effectiveFilter)

  const columns: ProColumns<TrialBalanceRow>[] = [
    {
      title: '账户',
      dataIndex: 'name',
      render: (_dom: unknown, row: TrialBalanceRow) => {
        const label = accountNameMap.get(row.name) ?? row.name
        return label === row.name ? row.name : <Tooltip title={row.name}>{label}</Tooltip>
      }
    },
    { title: '期初', dataIndex: 'opening', align: 'right', render: (_dom: unknown, row: TrialBalanceRow) => <TrialBalanceCellView cell={row.opening} /> },
    { title: '发生', dataIndex: 'period', align: 'right', render: (_dom: unknown, row: TrialBalanceRow) => <TrialBalanceCellView cell={row.period} /> },
    { title: '期末', dataIndex: 'closing', align: 'right', render: (_dom: unknown, row: TrialBalanceRow) => <TrialBalanceCellView cell={row.closing} /> }
  ]

  const balanceTable = (
    <>
      <div className="reconcile-toolbar reconcile-trial-toolbar">
        <DatePicker.RangePicker
          allowClear
          value={range}
          placeholder={['起始日期', '结束日期']}
          onChange={(dates) => {
            setRange(dates && dates[0] && dates[1] ? ([dates[0], dates[1]] as [Dayjs, Dayjs]) : null)
          }}
        />
        {currencies.length > 0 && (
          <Space size={4} wrap>
            <span className="reconcile-currency-label">币种：</span>
            <Tag.CheckableTag checked={effectiveFilter === null} onChange={() => setCurrencyFilter(null)}>
              全部
            </Tag.CheckableTag>
            {currencies.map((c) => (
              <Tag.CheckableTag key={c} checked={effectiveFilter === c} onChange={() => setCurrencyFilter(c)}>
                {c}
              </Tag.CheckableTag>
            ))}
          </Space>
        )}
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <Spin spinning={loading}>
        <ProTable<TrialBalanceRow>
          size="small"
          rowKey={(r) => `${r.name}:${r.opening.currency}`}
          dataSource={visibleRows}
          columns={columns}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无余额数据，请先录入账目" /> }}
          search={false}
          options={false}
        />
      </Spin>
    </>
  )

  return (
    <Tabs
      defaultActiveKey="balances"
      items={[
        { key: 'balances', label: '科目余额表', children: balanceTable },
        { key: 'detail', label: '明细账', children: <DetailLedgerTab /> }
      ]}
    />
  )
}
