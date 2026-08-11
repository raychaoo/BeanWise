/**
 * M8 报表视图（T4）：粒度 Segmented + 三面板（净资产趋势 Line / 收支对比 Column /
 * 账户余额树表格）。图表 y 值 Number() 仅显示层，精确金额由余额表十进制字符串提供。
 */
import { Column, Line } from '@ant-design/charts'
import { Alert, Card, Empty, Segmented, Spin, Table, Typography } from 'antd'
import { useEffect } from 'react'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'
import { useReportsStore } from '../stores/reports'

/** 趋势点 → 图数据（三序列展开） */
function toTrendSeries(points: NetWorthPoint[]): Array<{ period: string; series: string; value: number }> {
  return points.flatMap((p) => [
    { period: p.period, series: '资产', value: Number(p.assets) },
    { period: p.period, series: '负债', value: Number(p.liabilities) },
    { period: p.period, series: '净资产', value: Number(p.netWorth) }
  ])
}

/** 收支点 → 图数据（收入/支出两序列展开） */
function toIncomeExpenseSeries(points: IncomeExpensePoint[]): Array<{ period: string; type: string; value: number }> {
  return points.flatMap((p) => [
    { period: p.period, type: '收入', value: Number(p.income) },
    { period: p.period, type: '支出', value: Number(p.expense) }
  ])
}

function BalanceCell({ balances }: { balances: Array<{ currency: string; number: string }> }) {
  return (
    <span>{balances.map((b) => `${b.number} ${b.currency}`).join(' / ') || '—'}</span>
  )
}

export default function ReportsView() {
  const granularity = useReportsStore((s) => s.granularity)
  const setGranularity = useReportsStore((s) => s.setGranularity)
  const netWorth = useReportsStore((s) => s.netWorth)
  const balances = useReportsStore((s) => s.balances)
  const incomeExpense = useReportsStore((s) => s.incomeExpense)
  const loading = useReportsStore((s) => s.loading)
  const error = useReportsStore((s) => s.error)
  const currency = useReportsStore((s) => s.currency)
  const status = useLedgerStore((s) => s.status)

  useEffect(() => {
    void useReportsStore.getState().reloadAll()
  }, [])

  const hasData = (netWorth?.length ?? 0) > 0 || (incomeExpense?.length ?? 0) > 0 || (balances?.length ?? 0) > 0

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Segmented
          value={granularity}
          onChange={(v) => { if (typeof v === 'string') setGranularity(v as 'month' | 'year') }}
          options={[
            { label: '月', value: 'month' },
            { label: '年', value: 'year' }
          ]}
        />
        {currency && <Typography.Text type="secondary">运营货币：{currency}</Typography.Text>}
      </div>

      {status && status.status !== 'ok' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="索引异常，数据可能不完整，请先重建索引"
          description={status.lastError ?? undefined}
        />
      )}
      {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error} />}

      <Spin spinning={loading}>
        {hasData ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Card title="净资产趋势" style={{ gridColumn: '1 / -1' }}>
              <Line
                data={toTrendSeries(netWorth ?? [])}
                xField="period"
                yField="value"
                colorField="series"
                height={280}
              />
            </Card>
            <Card title="收支对比">
              <Column
                data={toIncomeExpenseSeries(incomeExpense ?? [])}
                xField="period"
                yField="value"
                colorField="type"
                height={280}
              />
            </Card>
            <Card title="账户余额">
              <Table<AccountBalance>
                dataSource={balances ?? []}
                rowKey="name"
                pagination={false}
                expandable={{ defaultExpandAllRows: true }}
                columns={[
                  { title: '账户', dataIndex: 'name' },
                  { title: '余额', dataIndex: 'balances', render: (b: Array<{ currency: string; number: string }>) => <BalanceCell balances={b} /> }
                ]}
              />
            </Card>
          </div>
        ) : (
          <Empty description="暂无数据，请先录入账目" />
        )}
      </Spin>
    </div>
  )
}
