/**
 * M8 报表视图（T4）+ 批次 E Task 3 三表排版 + 批次 G 现金流量表：外层 Tabs
 * （趋势图表 / 资产负债表 / 利润表 / 现金流量表）。
 * 默认 Tab「趋势图表」保持既有 DOM（粒度 Segmented + 起止年 Select + 三卡片——
 * e2e/reports.spec.ts 依赖，不得移动）；资产负债表/利润表见 views/reports/*。
 * 图表 y 值 Number() 仅显示层，精确金额由报表 Tab 十进制字符串提供。
 * destroyInactiveTabPane=false 保切换状态；图表懒加载（LazyLine/LazyColumn）。
 */
import { DownloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Segmented, Select, Spin, Table, Tabs, Tooltip, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint } from '../../../../shared/ipc'
import LazyColumn from '../../components/LazyColumn'
import LazyLine from '../../components/LazyLine'
import { useLedgerStore } from '../../stores/ledger'
import { useReportsStore } from '../../stores/reports'
import BalanceSheetTable from './BalanceSheetTable'
import CashFlowTable from './CashFlowTable'
import IncomeStatementTable from './IncomeStatementTable'
import '../../styles/views/reports.less'

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

/** 默认 Tab：粒度/起止年筛选 + 三卡片（净资产趋势 / 收支对比 / 账户余额）——结构与标题不动（e2e 依赖） */
function TrendPane() {
  const granularity = useReportsStore((s) => s.granularity)
  const setGranularity = useReportsStore((s) => s.setGranularity)
  const startYear = useReportsStore((s) => s.startYear)
  const endYear = useReportsStore((s) => s.endYear)
  const setYearRange = useReportsStore((s) => s.setYearRange)
  const availableYears = useReportsStore((s) => s.availableYears)
  const netWorth = useReportsStore((s) => s.netWorth)
  const balances = useReportsStore((s) => s.balances)
  const incomeExpense = useReportsStore((s) => s.incomeExpense)
  const loading = useReportsStore((s) => s.loading)
  const error = useReportsStore((s) => s.error)
  const currency = useReportsStore((s) => s.currency)
  const status = useLedgerStore((s) => s.status)
  const accountOptions = useLedgerStore((s) => s.accountOptions)

  useEffect(() => {
    void useReportsStore.getState().reloadAll()
  }, [])

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))
  const hasData = (netWorth?.length ?? 0) > 0 || (incomeExpense?.length ?? 0) > 0 || (balances?.length ?? 0) > 0

  /** 年份下拉选项（账本全量年份范围，不随筛选收缩） */
  const yearOptions = (() => {
    if (!availableYears || availableYears.max <= 0) return []
    const options: Array<{ label: string; value: number }> = []
    for (let y = availableYears.min; y <= availableYears.max; y++) options.push({ label: `${y}年`, value: y })
    return options
  })()
  const yearSelectDisabled = yearOptions.length === 0

  return (
    <div>
      <div className="report-filter-bar" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Segmented
          value={granularity}
          onChange={(v) => { if (typeof v === 'string') setGranularity(v as 'month' | 'year') }}
          options={[
            { label: '月', value: 'month' },
            { label: '年', value: 'year' }
          ]}
        />
        <Select
          aria-label="起始年"
          placeholder="起始年"
          allowClear
          style={{ width: 110 }}
          value={startYear ?? undefined}
          options={yearOptions}
          onChange={(v) => setYearRange(v ?? null, endYear)}
          disabled={yearSelectDisabled}
        />
        <Typography.Text type="secondary">至</Typography.Text>
        <Select
          aria-label="结束年"
          placeholder="结束年"
          allowClear
          style={{ width: 110 }}
          value={endYear ?? undefined}
          options={yearOptions}
          onChange={(v) => setYearRange(startYear, v ?? null)}
          disabled={yearSelectDisabled}
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
              <LazyLine
                data={toTrendSeries(netWorth ?? [])}
                xField="period"
                yField="value"
                colorField="series"
                height={280}
              />
            </Card>
            <Card title="收支对比">
              <LazyColumn
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
                  {
                    title: '账户',
                    dataIndex: 'name',
                    render: (name: string) => {
                      const label = accountNameMap.get(name) ?? name
                      return label === name ? name : <Tooltip title={name}>{label}</Tooltip>
                    }
                  },
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

export default function ReportsView() {
  const [exporting, setExporting] = useState(false)

  /** 导出 PDF：printToPDF + 保存对话框（取消静默；失败 message.error） */
  const handleExport = async () => {
    setExporting(true)
    try {
      const r = await window.beanwise.exportReportPdf()
      if (!r.ok) message.error(r.message ?? '导出 PDF 失败')
      else if (r.path) message.success(`已导出: ${r.path}`)
      // 取消保存 → { ok:true } 无 path，静默
    } catch (err) {
      message.error(`导出 PDF 失败：${String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <div className="reports-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          报表
        </Typography.Title>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          loading={exporting}
          onClick={() => void handleExport()}
          className="report-export-btn"
        >
          导出 PDF
        </Button>
      </div>
      <Tabs
        defaultActiveKey="trend"
        destroyInactiveTabPane={false}
        items={[
          // print-area：仅激活 Tab 的报表区参与 PDF 输出（@media print 隔离）
          { key: 'trend', label: '趋势图表', children: <div className="print-area"><TrendPane /></div> },
          { key: 'balance', label: '资产负债表', children: <div className="print-area"><BalanceSheetTable /></div> },
          { key: 'income', label: '利润表', children: <div className="print-area"><IncomeStatementTable /></div> },
          { key: 'cash-flow', label: '现金流量表', children: <div className="print-area"><CashFlowTable /></div> }
        ]}
      />
    </div>
  )
}
