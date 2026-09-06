/**
 * 资产负债表（账户式，批次 E Task 3，方案模块 6）：左栏「资产」列 Assets:* 叶子账户，
 * 右栏「负债和所有者权益」列 Liabilities:* / Equity:* 叶子（翻转正显示）+ 未分配利润
 * （累计损益——未结转损益的账本亦满足恒等式）；底部「资产 = 负债 + 权益」校验行
 * （addDecimalStrings / computeBalancingNumber，相等绿 Tag、不等红差额）。
 * 按运营货币单币种列示（正式报表口径，多币种全貌见「趋势图表」Tab 账户余额表）。
 * 数据零 IPC 变更：getBalancesReport（期末快照，仅 endYear 年粒度）+ getIncomeExpenseReport
 * （year 粒度累计净利润）。期间选择 TimeRangeBar（granularity），截所选范围终点年末。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { Alert, Card, Empty, Spin, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useState, type ReactNode } from 'react'
import { isZeroDecimal } from '../../../../shared/decimal'
import type { AccountBalance } from '../../../../shared/ipc'
import TimeRangeBar from '../../components/TimeRangeBar'
import type { TimeRangeValue } from '../../hooks/useTimeRange'
import { useLedgerStore } from '../../stores/ledger'
import { useReportsStore } from '../../stores/reports'
import { formatAmount } from '../../utils/format'
import { buildBalanceSheetRows, netIncomeFromSeries, type StatementRow } from './statement'
import '../../styles/views/reports.less'

/** 报表行 → Table dataSource；负数金额挂 .num-negative（红色语义唯一化） */
function amountCell(value: string): ReactNode {
  return <span className={`num${value.startsWith('-') ? ' num-negative' : ''}`}>{formatAmount(value)}</span>
}

const COLUMNS: ProColumns<StatementRow>[] = [
  {
    title: '项目',
    dataIndex: 'label',
    key: 'label'
  },
  {
    title: '金额',
    dataIndex: 'amount',
    key: 'amount',
    align: 'right' as const,
    render: (_dom: unknown, row: StatementRow) => amountCell(row.amount)
  }
]

export default function BalanceSheetTable() {
  const storeCurrency = useReportsStore((s) => s.currency)
  const currency = storeCurrency || 'CNY'
  const accountOptions = useLedgerStore((s) => s.accountOptions)

  // 期末快照通道仅支持 endYear（年粒度）；粒度切到「月」时亦按终点所在年取快照
  const [range, setRange] = useState<TimeRangeValue>({ preset: 'all', range: null, granularity: 'year' })
  const endYear = range.range ? range.range[1].year() : null

  const [accounts, setAccounts] = useState<AccountBalance[] | null>(null)
  const [retainedEarnings, setRetainedEarnings] = useState<string>('0')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      window.beanwise.getBalancesReport(endYear !== null ? { endYear } : {}),
      window.beanwise.getIncomeExpenseReport({ granularity: 'year' })
    ])
      .then(([bal, ie]) => {
        if (cancelled) return
        setAccounts(bal.accounts)
        setRetainedEarnings(netIncomeFromSeries(ie.series))
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
  }, [endYear])

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))
  const sheet =
    accounts !== null
      ? buildBalanceSheetRows(accounts, currency, retainedEarnings)
      : null
  const balanced = sheet !== null && isZeroDecimal(sheet.diff)
  const hasAnyAccount = (accounts?.length ?? 0) > 0

  /** 账户行显示名：账户库中文名优先（悬浮显示 Beancount 路径），同「趋势图表」Tab 模式 */
  const renderLabel = (label: string): ReactNode => {
    const name = accountNameMap.get(label) ?? label
    return name === label ? label : <Tooltip title={label}>{name}</Tooltip>
  }

  const renderTable = (rows: StatementRow[], rowKeyPrefix: string) => (
    <ProTable<StatementRow>
      size="small"
      pagination={false}
      dataSource={rows}
      rowKey="key"
      rowClassName={(r) => `report-row report-row--${r.kind}`}
      search={false}
      options={false}
      columns={COLUMNS.map((c, idx) =>
        idx === 0
          ? { ...c, render: (_dom: unknown, r: StatementRow) => (r.kind === 'item' ? renderLabel(r.label) : r.label) }
          : c
      )}
      key={rowKeyPrefix}
    />
  )

  return (
    <div className="report-sheet">
      <div className="report-sheet__head">
        <Typography.Title level={4} style={{ margin: 0 }}>
          资产负债表
        </Typography.Title>
        <TimeRangeBar value={range} showPresets={false} showGranularity onChange={setRange} />
        <Typography.Text type="secondary">
          期末快照：截至 {endYear !== null ? `${endYear} 年末` : '最新'} · 单位：{currency}（运营货币）
        </Typography.Text>
      </div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error} />}
      <Spin spinning={loading}>
        {hasAnyAccount ? (
          <>
            <div className="report-sheet__columns">
              <Card size="small" title="资产">
                {sheet && renderTable(sheet.left, 'left')}
              </Card>
              <Card size="small" title="负债和所有者权益">
                {sheet && renderTable(sheet.right, 'right')}
              </Card>
            </div>
            <div className="report-check-bar">
              {balanced ? (
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  校验通过：资产 = 负债 + 权益（{formatAmount(sheet!.assetsTotal)} {currency}）
                </Tag>
              ) : (
                <Tag color="error" icon={<CloseCircleOutlined />}>
                  校验失败：资产 {formatAmount(sheet!.assetsTotal)} ≠ 负债和权益 {formatAmount(sheet!.rightTotal)}，差额{' '}
                  {formatAmount(sheet!.diff)} {currency}
                </Tag>
              )}
            </div>
          </>
        ) : (
          <Empty description="暂无数据，请先录入账目" />
        )}
      </Spin>
    </div>
  )
}
