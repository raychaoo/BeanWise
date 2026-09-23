/**
 * 利润表（报告式，批次 E Task 3，方案模块 6）：上下一栏——本月（YYYY年MM）收入/支出/
 * 净利润汇总 + 累计明细（收入叶子逐行 → 收入小计 → 支出叶子逐行 → 支出小计 →
 * 净利润（累计）强调行，正负按 .num-negative 规则）。
 * 月份 DatePicker picker="month" 单选传参：本月数取 getIncomeExpenseReport（month 粒度，
 * startYear=endYear=所选年）对应期点；累计明细取 getBalancesReport（endYear=所选年——
 * 余额通道仅支持年粒度期末快照，明细区如实标注「截至所选年年末累计」）。零 IPC 变更。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { Alert, Card, DatePicker, Empty, Spin, Tooltip, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useEffect, useState, type ReactNode } from 'react'
import type { AccountBalance, IncomeExpensePoint } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import { useReportsStore } from '../../stores/reports'
import { formatAmount } from '../../utils/format'
import { INTERNAL_TRANSFER_NOTE } from '../../utils/internalTransfer'
import { buildIncomeStatementRows, flattenLeaves, type StatementRow } from './statement'
import '../../styles/views/reports.less'

/** 报表行 → Table dataSource；负数（赤字）挂 .num-negative（红色语义唯一化） */
function amountCell(value: string): ReactNode {
  return <span className={`num${value.startsWith('-') ? ' num-negative' : ''}`}>{formatAmount(value)}</span>
}

export default function IncomeStatementTable() {
  const storeCurrency = useReportsStore((s) => s.currency)
  const currency = storeCurrency || 'CNY'
  const accountOptions = useLedgerStore((s) => s.accountOptions)

  const [month, setMonth] = useState<Dayjs>(() => dayjs())
  const year = month.year()
  const period = month.format('YYYY-MM')

  const [accounts, setAccounts] = useState<AccountBalance[] | null>(null)
  const [monthPoint, setMonthPoint] = useState<IncomeExpensePoint | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      window.beanwise.getBalancesReport({ endYear: year }),
      window.beanwise.getIncomeExpenseReport({ granularity: 'month', startYear: year, endYear: year })
    ])
      .then(([bal, ie]) => {
        if (cancelled) return
        setAccounts(bal.accounts)
        setMonthPoint(ie.series.find((p) => p.period === period) ?? null)
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
  }, [year, period])

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))
  const rootOf = (name: string): AccountBalance | undefined => accounts?.find((n) => n.name === name)
  const incomeLeaves = rootOf('Income') ? flattenLeaves(rootOf('Income')!) : []
  const expenseLeaves = rootOf('Expenses') ? flattenLeaves(rootOf('Expenses')!) : []
  const hasAny =
    incomeLeaves.length + expenseLeaves.length > 0 ||
    (monthPoint !== null && (monthPoint.income !== '0' || monthPoint.expense !== '0'))

  const sheet =
    accounts !== null
      ? buildIncomeStatementRows(monthPoint, month.format('YYYY年MM月'), incomeLeaves, expenseLeaves, currency, year)
      : null

  /** 账户行显示名：账户库中文名优先（悬浮显示 Beancount 路径），同「趋势图表」Tab 模式 */
  const renderLabel = (label: string): ReactNode => {
    const name = accountNameMap.get(label) ?? label
    return name === label ? label : <Tooltip title={label}>{name}</Tooltip>
  }

  return (
    <div className="report-sheet">
      <div className="report-sheet__head">
        <Typography.Title level={4} style={{ margin: 0 }}>
          利润表
        </Typography.Title>
        <DatePicker
          picker="month"
          value={month}
          allowClear={false}
          onChange={(m) => {
            if (m) setMonth(m)
          }}
          aria-label="利润表月份"
        />
        <Typography.Text type="secondary">
          本月口径：自然月 · 明细口径：截至 {year} 年末累计 · 单位：{currency}（运营货币）
        </Typography.Text>
        {/*
          * 口径单源（utils/internalTransfer）。作兄弟节点而非并入上一句：.report-sheet__head 是
          * flex + gap:16px + wrap（reports.less:44-50），单个 flex item 会在自己内部按 CJK 断行、
          * 把上面那句从中间劈开；兄弟节点则整块折到第二行，行距由 gap 提供（故不加 .note-secondary）。
          */}
        <Typography.Text type="secondary">{INTERNAL_TRANSFER_NOTE}</Typography.Text>
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error} />}
      <Spin spinning={loading}>
        {hasAny && sheet !== null ? (
          <Card size="small">
            <ProTable<StatementRow>
              size="small"
              pagination={false}
              dataSource={sheet.rows}
              rowKey="key"
              rowClassName={(r) => `report-row report-row--${r.kind}`}
              search={false}
              options={false}
              columns={[
                {
                  title: '项目',
                  dataIndex: 'label',
                  key: 'label',
                  onCell: (r: StatementRow) => ({ colSpan: r.kind === 'section' ? 2 : 1 }),
                  render: (_dom: unknown, r: StatementRow) => (r.kind === 'item' ? renderLabel(r.label) : r.label)
                },
                {
                  title: `金额（${currency}）`,
                  dataIndex: 'amount',
                  key: 'amount',
                  align: 'right',
                  onCell: (r: StatementRow) => ({ colSpan: r.kind === 'section' ? 0 : 1 }),
                  render: (_dom: unknown, r: StatementRow) => amountCell(r.amount)
                }
              ]}
            />
          </Card>
        ) : (
          <Empty description="暂无数据，请先录入账目" />
        )}
      </Spin>
    </div>
  )
}
