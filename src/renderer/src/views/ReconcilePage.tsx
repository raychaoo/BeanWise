/**
 * 对账页：Tab① 科目余额表（report:balances 树形表格，顶部年份 RangePicker →
 * ReportBalancesParams 既有参数；余额为期末快照，仅 endYear 参与过滤；批次 G 范围）
 * + Tab② 明细账（批次 F）：账户 TreeSelect（五大类分组）→ listEntries 服务端 account
 * 精确过滤 + order desc 分页查询；本地查询状态（不经共享 store entries 槽，防跨页串扰）。
 * 金额 formatAmount 千分位 + .num 右对齐，负数 .num-negative（红色语义唯一化）。
 */
import { Alert, Button, DatePicker, Empty, Spin, Table, Tabs, Tooltip, TreeSelect } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Key } from 'react'
import type { AccountBalance, LedgerEntryRow, ReportBalancesParams } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'
import type { AccountOption } from '../stores/ledger'
import { formatAmount } from '../utils/format'
import '../styles/views/reconcile.less'

/** 展开全部树节点（数据异步到达后受控展开，defaultExpandAllRows 只在首渲染生效） */
function collectKeys(nodes: AccountBalance[]): string[] {
  return nodes.flatMap((n) => [n.name, ...collectKeys(n.children ?? [])])
}

/** 多币种余额单元格：每币种一行（formatAmount + 币种），负数红 */
function BalanceCell({ balances }: { balances: Array<{ currency: string; number: string }> }) {
  if (balances.length === 0) return <span className="num">—</span>
  return (
    <span className="reconcile-balance-cell">
      {balances.map((b) => (
        <span key={b.currency} className={`num${b.number.startsWith('-') ? ' num-negative' : ''}`}>
          {formatAmount(b.number)} {b.currency}
        </span>
      ))}
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
  const [rows, setRows] = useState<LedgerEntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadEntries = useCallback(async (acc: string, p: number) => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.beanwise.listLedgerEntries({
        account: acc,
        order: 'desc',
        limit: DETAIL_PAGE_SIZE,
        offset: (p - 1) * DETAIL_PAGE_SIZE
      })
      setRows(r.entries)
      setTotal(r.total)
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
    if (value) void loadEntries(value, 1)
  }

  const handleSearch = () => {
    if (!account) return
    setPage(1)
    void loadEntries(account, 1)
  }

  const handlePageChange = (p: number) => {
    setPage(p)
    if (account) void loadEntries(account, p)
  }

  const accountLabel = account ? (accountNameMap.get(account) ?? account) : null

  const columns: ColumnsType<LedgerEntryRow> = [
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '交易对象', dataIndex: 'payee', render: (v: string | null) => v ?? '—', ellipsis: true },
    { title: '说明', dataIndex: 'narration', render: (v: string | null) => v ?? '—', ellipsis: true },
    {
      title: '账户',
      dataIndex: 'account',
      // 服务端精确过滤后每行均属所选账户：中文映射 + Tooltip 原名
      render: () =>
        accountLabel === null ? (
          '—'
        ) : accountLabel === account ? (
          account
        ) : (
          <Tooltip title={account}>{accountLabel}</Tooltip>
        )
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      // 交易金额（超 UI 层 #1）：资产流视角（收入 +、支出 -），千分位 + 负数红；转账/Open 行无金额
      render: (v: string | null) =>
        v === null ? '—' : <span className={`num${v.startsWith('-') ? ' num-negative' : ''}`}>{formatAmount(v)}</span>
    },
    { title: '币种', dataIndex: 'currency', width: 80, render: (v: string | null) => v ?? '—' }
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
        <Button type="primary" disabled={!account} onClick={handleSearch}>
          查询
        </Button>
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <Table<LedgerEntryRow>
        rowKey="id"
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
      />
    </>
  )
}

export default function ReconcilePage() {
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))
  const [yearRange, setYearRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [balances, setBalances] = useState<AccountBalance[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([])

  const load = useCallback(async (range: [Dayjs, Dayjs] | null) => {
    setLoading(true)
    setError(null)
    try {
      // 既有参数：余额为期末快照，仅 endYear 参与过滤（startYear 携带不改变快照口径）
      const params: ReportBalancesParams = range ? { startYear: range[0].year(), endYear: range[1].year() } : {}
      const r = await window.beanwise.getBalancesReport(params)
      setBalances(r.accounts)
      setExpandedKeys(collectKeys(r.accounts))
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(yearRange)
  }, [load, yearRange])

  const columns: ColumnsType<AccountBalance> = [
    {
      title: '账户',
      dataIndex: 'name',
      render: (name: string) => {
        const label = accountNameMap.get(name) ?? name
        return label === name ? name : <Tooltip title={name}>{label}</Tooltip>
      }
    },
    {
      title: '余额',
      dataIndex: 'balances',
      align: 'right',
      render: (b: Array<{ currency: string; number: string }>) => <BalanceCell balances={b} />
    }
  ]

  const balanceTable = (
    <>
      <div className="reconcile-toolbar">
        <DatePicker.RangePicker
          picker="year"
          allowClear
          value={yearRange}
          placeholder={['起始年', '结束年']}
          onChange={(dates) => {
            setYearRange(dates && dates[0] && dates[1] ? ([dates[0], dates[1]] as [Dayjs, Dayjs]) : null)
          }}
        />
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <Spin spinning={loading}>
        <Table<AccountBalance>
          size="small"
          rowKey="name"
          dataSource={balances}
          columns={columns}
          pagination={false}
          expandedRowKeys={expandedKeys}
          onExpandedRowsChange={(keys) => setExpandedKeys([...keys])}
          locale={{ emptyText: <Empty description="暂无余额数据，请先录入账目" /> }}
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
