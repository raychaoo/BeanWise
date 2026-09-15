/**
 * 往来账流水（ADR 23 展开下钻）：主表某往来对象行的展开区——该对象该币种下的逐笔交易。
 *
 * 独立组件而非主表内联，是因为分页状态要按「一个展开的往来对象」各自持有；ProTable 展开区
 * 内容随折叠卸载，取数天然按需（打开报表不背全量流水的传输）。数据走服务端分页
 * （report:counterparty-transactions：limit/offset + total）；累计余额由主进程按全量升序算出，
 * 分页只切输出不切累计起点——每页余额与主表该行「净额」同口径（最新一笔 === 净额）。
 * 金额全程十进制字符串（formatAmount 千分位纯字符串处理），禁浮点。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { Alert, Empty, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import type { CounterpartyFlowRow } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import { formatAmount } from '../../utils/format'

/** 展开区分页每页条数（汇总表不分页，分页器只属于流水） */
const PAGE_SIZE = 10

/** 未标注对象的行在表里的显示名（与主表一致） */
const UNASSIGNED_LABEL = '未指定'

/** 金额单元格：千分位 + .num 右对齐，负数红 */
function NumCell({ value }: { value: string }) {
  return <span className={`num${value.startsWith('-') ? ' num-negative' : ''}`}>{formatAmount(value)}</span>
}

export default function CounterpartyFlowTable({
  counterparty,
  currency
}: {
  counterparty: string | null
  currency: string
}) {
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<CounterpartyFlowRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const accountOptions = useLedgerStore((s) => s.accountOptions)

  const load = useCallback(
    async (p: number) => {
      setLoading(true)
      setError(null)
      try {
        const r = await window.beanwise.getCounterpartyTransactions({
          counterparty,
          currency,
          limit: PAGE_SIZE,
          offset: (p - 1) * PAGE_SIZE
        })
        setRows(r.rows)
        setTotal(r.total)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    },
    [counterparty, currency]
  )

  // 展开即拉第一页；对象/币种变化（同一展开位换了行）回到第一页重查
  useEffect(() => {
    setPage(1)
    void load(1)
  }, [load])

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))

  const columns: ProColumns<CounterpartyFlowRow>[] = [
    { title: '日期', dataIndex: 'date', width: 110 },
    {
      title: '交易对象',
      dataIndex: 'payee',
      render: (_dom: unknown, row: CounterpartyFlowRow) => row.payee ?? '—'
    },
    {
      title: '说明',
      dataIndex: 'narration',
      render: (_dom: unknown, row: CounterpartyFlowRow) => row.narration ?? '—'
    },
    {
      title: '账户',
      dataIndex: 'account',
      render: (_dom: unknown, row: CounterpartyFlowRow) => accountNameMap.get(row.account) ?? row.account
    },
    {
      title: '金额',
      dataIndex: 'number',
      align: 'right',
      width: 130,
      render: (_dom: unknown, row: CounterpartyFlowRow) => <NumCell value={row.number} />
    },
    {
      title: '余额',
      dataIndex: 'balance',
      align: 'right',
      width: 130,
      render: (_dom: unknown, row: CounterpartyFlowRow) => <NumCell value={row.balance} />
    }
  ]

  return (
    <div className="counterparty-flow">
      <div className="counterparty-flow__head">
        <Typography.Text strong>
          {counterparty ?? UNASSIGNED_LABEL} · {currency} 流水
        </Typography.Text>
        <Typography.Text type="secondary">共 {total} 笔 · 最新在前</Typography.Text>
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} />}
      <ProTable<CounterpartyFlowRow>
        size="small"
        rowKey="entryId"
        dataSource={rows}
        columns={columns}
        loading={loading}
        pagination={{
          pageSize: PAGE_SIZE,
          total,
          current: page,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p) => {
            setPage(p)
            void load(p)
          }
        }}
        locale={{ emptyText: <Empty description="暂无流水" /> }}
        search={false}
        options={false}
      />
    </div>
  )
}
