/**
 * 对账页（批次 D Task 4，方案模块 5）：Tab① 科目余额表（report:balances 树形表格，
 * 顶部年份 RangePicker → ReportBalancesParams 既有参数；余额为期末快照，仅 endYear 参与过滤）
 * + Tab② 明细账占位（需索引账户过滤查询支持，超 UI 层 #2，有 UI 无假数据）。
 * 金额多币种 formatAmount 千分位 + .num 右对齐，负数 .num-negative（红色语义唯一化）。
 */
import { Alert, DatePicker, Empty, Spin, Table, Tabs, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import type { Key } from 'react'
import type { AccountBalance, ReportBalancesParams } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'
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
        {
          key: 'detail',
          label: '明细账',
          children: <Empty description="需索引账户过滤查询支持（超 UI 层 #2），当前版本暂未开放" style={{ marginTop: 48 }} />
        }
      ]}
    />
  )
}
