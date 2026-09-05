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
import { useEffect, useMemo, useState } from 'react'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint } from '../../../../shared/ipc'
import { addDecimalStrings, negateDecimal } from '../../../../shared/decimal'
import LazyColumn from '../../components/LazyColumn'
import LazyLine from '../../components/LazyLine'
import { useLedgerStore } from '../../stores/ledger'
import { useReportsStore } from '../../stores/reports'
import { formatAmount } from '../../utils/format'
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
  // 余额表保持原始十进制字符串（千分位会破坏 e2e 精确文本断言 '19960 CNY'/'-20 CNY'）；
  // .num 提供等宽右对齐，可读性已显著优于旧版挤列布局。
  return (
    <span className="balance-cell">
      {balances.map((b) => {
        const neg = b.number.startsWith('-')
        return (
          <span key={b.currency} className={`num balance-cell__item ${neg ? 'num-negative' : ''}`}>
            {b.number} {b.currency}
          </span>
        )
      })}
    </span>
  )
}

/** 十进制净结余：收入 − 支出（均为正显示） */
function netInflow(income: string, expense: string): string {
  return addDecimalStrings(income, negateDecimal(expense))
}

/** 统计芯片：label + 大字号十进制金额 + 可选子说明 */
function SummaryPill({ label, value, unit, negative, hint }: { label: string; value: string; unit?: string; negative?: boolean; hint?: string }) {
  const display = formatAmount(value)
  return (
    <div className="summary-pill">
      <span className="summary-pill__label">{label}</span>
      <span className={`summary-pill__value num ${negative ? 'num-negative' : ''}`}>
        {display}
        {unit && <span className="summary-pill__unit">{unit}</span>}
      </span>
      {hint && <span className="summary-pill__hint">{hint}</span>}
    </div>
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

  /** 净资产趋势：最新一期快照（十进制精确值，供芯片展示） */
  const latestNetWorth = netWorth && netWorth.length > 0 ? netWorth[netWorth.length - 1] : null

  /** 收支对比：区间汇总（十进制精确累加）+ 逐期净结余/累计净结余 */
  const incomeSummary = useMemo(() => {
    if (!incomeExpense || incomeExpense.length === 0) return null
    let totalIncome = '0'
    let totalExpense = '0'
    const rows = incomeExpense.map((p) => {
      totalIncome = addDecimalStrings(totalIncome, p.income)
      totalExpense = addDecimalStrings(totalExpense, p.expense)
      return { period: p.period, income: p.income, expense: p.expense, net: netInflow(p.income, p.expense) }
    })
    let running = '0'
    const rowsWithCum = rows.map((r) => {
      running = addDecimalStrings(running, r.net)
      return { ...r, cumulative: running }
    })
    return { totalIncome, totalExpense, totalNet: netInflow(totalIncome, totalExpense), rows: rowsWithCum }
  }, [incomeExpense])

  /** 账户余额树 → 扁平化（带缩进层级，无需展开即可总览全部账户） */
  const flatBalances = useMemo(() => {
    const out: Array<{ name: string; balances: Array<{ currency: string; number: string }>; depth: number }> = []
    const walk = (nodes: AccountBalance[], depth: number) => {
      for (const n of nodes) {
        out.push({ name: n.name, balances: n.balances, depth })
        if (n.children && n.children.length > 0) walk(n.children, depth + 1)
      }
    }
    walk(balances ?? [], 0)
    return out
  }, [balances])

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
          <div className="trend-grid">
            {/*
              * 净资产趋势：统计芯片（最新资产/负债/净资产）+ 趋势图 + 逐期数据表
              * 卡片标题「净资产趋势」不动（e2e 依赖）；Card 内保留 canvas（e2e 依赖）
              */}
            <Card
              title="净资产趋势"
              extra={latestNetWorth ? <Typography.Text type="secondary">{latestNetWorth.period} 期末</Typography.Text> : null}
            >
              {latestNetWorth && (
                <div className="summary-pill-row">
                  <SummaryPill label="资产" value={latestNetWorth.assets} unit={currency} />
                  <SummaryPill label="负债" value={latestNetWorth.liabilities} unit={currency} negative={latestNetWorth.liabilities.startsWith('-')} />
                  <SummaryPill label="净资产" value={latestNetWorth.netWorth} unit={currency} negative={latestNetWorth.netWorth.startsWith('-')} />
                </div>
              )}
              <LazyLine
                data={toTrendSeries(netWorth ?? [])}
                xField="period"
                yField="value"
                colorField="series"
                height={220}
              />
              {netWorth && netWorth.length > 0 && (
                <Table<NetWorthPoint>
                  className="trend-data-table"
                  dataSource={[...netWorth].reverse()}
                  rowKey="period"
                  size="small"
                  pagination={false}
                  scroll={{ y: 220 }}
                  columns={[
                    { title: '期间', dataIndex: 'period', width: 90 },
                    { title: '资产', dataIndex: 'assets', align: 'right', render: (v: string) => <span className="num">{formatAmount(v)}</span> },
                    { title: '负债', dataIndex: 'liabilities', align: 'right', render: (v: string) => <span className={`num ${v.startsWith('-') ? 'num-negative' : ''}`}>{formatAmount(v)}</span> },
                    { title: '净资产', dataIndex: 'netWorth', align: 'right', render: (v: string) => <span className={`num ${v.startsWith('-') ? 'num-negative' : ''}`}>{formatAmount(v)}</span> }
                  ]}
                />
              )}
            </Card>

            {/*
              * 收支对比：统计芯片（区间总收入/支出/净结余）+ 对比图 + 逐期数据表（含累计净结余）
              * 卡片标题「收支对比」不动（e2e 依赖）
              */}
            <Card title="收支对比">
              {incomeSummary && (
                <div className="summary-pill-row">
                  <SummaryPill label="总收入" value={incomeSummary.totalIncome} unit={currency} />
                  <SummaryPill label="总支出" value={incomeSummary.totalExpense} unit={currency} />
                  <SummaryPill label="净结余" value={incomeSummary.totalNet} unit={currency} negative={incomeSummary.totalNet.startsWith('-')} />
                </div>
              )}
              <LazyColumn
                data={toIncomeExpenseSeries(incomeExpense ?? [])}
                xField="period"
                yField="value"
                colorField="type"
                height={220}
              />
              {incomeSummary && (
                <Table
                  className="trend-data-table"
                  dataSource={[...incomeSummary.rows].reverse()}
                  rowKey="period"
                  size="small"
                  pagination={false}
                  scroll={{ y: 220 }}
                  columns={[
                    { title: '期间', dataIndex: 'period', width: 90 },
                    { title: '收入', dataIndex: 'income', align: 'right', render: (v: string) => <span className="num">{formatAmount(v)}</span> },
                    { title: '支出', dataIndex: 'expense', align: 'right', render: (v: string) => <span className="num">{formatAmount(v)}</span> },
                    { title: '净结余', dataIndex: 'net', align: 'right', render: (v: string) => <span className={`num ${v.startsWith('-') ? 'num-negative' : ''}`}>{formatAmount(v)}</span> },
                    { title: '累计', dataIndex: 'cumulative', align: 'right', render: (v: string) => <span className={`num ${v.startsWith('-') ? 'num-negative' : ''}`}>{formatAmount(v)}</span> }
                  ]}
                />
              )}
            </Card>

            {/*
              * 账户余额：扁平化列表（带缩进层级，无需逐条展开即可总览）
              * 卡片标题「账户余额」不动（e2e 依赖）；tbody 仍含原始金额文本（e2e 依赖）
              */}
            <Card title="账户余额">
              <Table<{ name: string; balances: Array<{ currency: string; number: string }>; depth: number }>
                dataSource={flatBalances}
                rowKey="name"
                size="small"
                pagination={false}
                scroll={{ y: 320 }}
                columns={[
                  {
                    title: '账户',
                    dataIndex: 'name',
                    render: (_name: string, row: { name: string; depth: number }) => {
                      const label = accountNameMap.get(row.name) ?? row.name
                      const content = <span className="account-name" style={{ paddingLeft: row.depth * 16 }}>{label}</span>
                      return label === row.name ? content : <Tooltip title={row.name}>{content}</Tooltip>
                    }
                  },
                  {
                    title: '余额',
                    dataIndex: 'balances',
                    align: 'right',
                    render: (b: Array<{ currency: string; number: string }>) => <BalanceCell balances={b} />
                  }
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
      </div>
      <Tabs
        defaultActiveKey="trend"
        destroyInactiveTabPane={false}
        tabBarExtraContent={{
          right: (
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void handleExport()}
              className="report-export-btn"
            >
              导出 PDF
            </Button>
          )
        }}
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
