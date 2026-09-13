/**
 * 总览页（批次 D Task 3，方案模块 2）：
 * 第一行 4 × 指标卡（总资产/总负债/净资产/本月收支，运营货币）；
 * 第二行 收支对比趋势卡（收入/支出分组柱状图）+ 近 12 个月现金流量卡（净流入折线，按时间正序）；
 * 第三行 去向（支出类别 donut）+ 来源（收入类别 donut）；
 * 净资产趋势卡（本期实线 + 去年同期虚线，图顶统一筛选条）。
 * 指标聚合走 useDashboardStore（decimal 精确累加），Number() 仅图表 y 值显示层；
 * 每卡独立 Skeleton 防跳变。图表经 LazyLine / LazyColumn 懒加载（G2 体积大头不进首屏 chunk）。
 */
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Empty, Progress, Row, Skeleton, Statistic, Typography } from 'antd'
import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import LazyColumn from '../../components/LazyColumn'
import LazyLine from '../../components/LazyLine'
import TimeRangeBar from '../../components/TimeRangeBar'
import { useTimeRange } from '../../hooks/useTimeRange'
import type { TimeRangeValue } from '../../hooks/useTimeRange'
import { useDashboardStore } from '../../stores/dashboard'
import { useLedgerStore } from '../../stores/ledger'
import { useSemanticColors } from '../../theme/useSemanticColors'
import { useThemeContext } from '../../theme/ThemeProvider'
import { formatAmount } from '../../utils/format'
import { addDecimalStrings, negateDecimal } from '../../../../shared/decimal'
import type { IncomeExpensePoint, NetWorthPoint } from '../../../../shared/ipc'
import '../../styles/views/dashboard.less'

/** 期号回退一年：'2026-08' → '2025-08'，'2026' → '2025'（期号非金额，显示层字符串处理） */
function prevPeriod(period: string): string {
  const dash = period.indexOf('-')
  const year = Number(period.slice(0, dash === -1 ? period.length : dash)) - 1
  return `${year}${dash === -1 ? '' : period.slice(dash)}`
}

/** 净资产趋势图数据（显示层 Number）：本期实线点 + 去年同期虚线点对齐同一期号 */
function buildNetWorthTrendData(
  series: NetWorthPoint[],
  prevYear: NetWorthPoint[]
): Array<{ period: string; series: string; value: number }> {
  const prevByPeriod = new Map(prevYear.map((p) => [p.period, p]))
  const rows: Array<{ period: string; series: string; value: number }> = []
  for (const p of series) {
    rows.push({ period: p.period, series: '本期', value: Number(p.netWorth) })
    const prevPoint = prevByPeriod.get(prevPeriod(p.period))
    if (prevPoint) rows.push({ period: p.period, series: '去年同期', value: Number(prevPoint.netWorth) })
  }
  return rows
}

/** 收支对比图数据（显示层 Number）：收入/支出两序列展开 */
function buildIncomeExpenseData(
  points: IncomeExpensePoint[]
): Array<{ period: string; type: string; value: number }> {
  return points.flatMap((p) => [
    { period: p.period, type: '收入', value: Number(p.income) },
    { period: p.period, type: '支出', value: Number(p.expense) }
  ])
}

/** 指标卡骨架：高度对齐 Statistic（防跳变，方案交互清单 5） */
function MetricSkeleton() {
  return <Skeleton active title={false} paragraph={{ rows: 1 }} className="dash-metric-skeleton" />
}

/** 类别 donut 一行：色块 + 类别名 + 金额 + 百分比 */
function BreakdownRow({ color, name, amount, ratio }: { color: string; name: string; amount: string; ratio: string }) {
  const pct = Math.round(Number(ratio) * 1000) / 10 // ratio 十进制字符串 0~1 → 百分比
  return (
    <div className="dash-breakdown-row">
      <span className="dash-breakdown-row__dot" style={{ background: color }} />
      <Typography.Text className="dash-breakdown-row__name" ellipsis title={name}>
        {name}
      </Typography.Text>
      <span className="num dash-breakdown-row__amount">{formatAmount(amount)}</span>
      <Progress
        percent={pct}
        size="small"
        showInfo={false}
        strokeColor={color}
        trailColor="var(--bw-progress-trail)"
        className="dash-breakdown-row__bar"
      />
      <span className="num dash-breakdown-row__pct">{`${pct.toFixed(1)}%`}</span>
    </div>
  )
}

// 分类色板（非语义红绿，避免与流入流出语义冲突）：首位跟随主题主色，其余固定分类色
const BREAKDOWN_CATEGORICAL = ['#08979c', '#d46b08', '#389e0d', '#9254de', '#f759ab', '#8c8c8c']

/** 构建当前主题的分类色板：[主题主色, 固定分类色...] */
function breakdownColors(primary: string): string[] {
  return [primary, ...BREAKDOWN_CATEGORICAL]
}

/** 类别路径 → 中文显示名：匹配账户库中以该类别为前缀的账户，取中文名；无匹配则取末段 */
function resolveCategoryName(category: string, nameMap: Map<string, string>): string {
  if (category === '其他') return '其他'
  for (const [value, label] of nameMap) {
    if (value === category || value.startsWith(`${category}:`)) return label
  }
  return category.split(':').pop() ?? category
}

export default function DashboardPage() {
  const loading = useDashboardStore((s) => s.loading)
  const error = useDashboardStore((s) => s.error)
  const metrics = useDashboardStore((s) => s.metrics)
  const series = useDashboardStore((s) => s.series)
  const prevYearSeries = useDashboardStore((s) => s.prevYearSeries)
  const otherCurrencies = useDashboardStore((s) => s.otherCurrencies)
  const incomeExpense = useDashboardStore((s) => s.incomeExpense)
  const cashFlow = useDashboardStore((s) => s.cashFlow)
  const expenseBreakdown = useDashboardStore((s) => s.expenseBreakdown)
  const incomeBreakdown = useDashboardStore((s) => s.incomeBreakdown)
  const hasData = useDashboardStore((s) => s.hasData)
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const { mode } = useThemeContext()
  const colors = useSemanticColors()

  // 当前主题的分类色板（[主题主色, 固定分类色...]），跟随主题切换
  const breakdownPalette = useMemo(() => breakdownColors(colors.primary), [colors.primary])

  // 账户路径 → 中文显示名（匹配 value 前缀，取第一个配置的中文名）
  const accountNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of accountOptions) m.set(o.value, o.label)
    return m
  }, [accountOptions])

  const tr = useTimeRange({ granularity: 'month' })
  const rangeValue: TimeRangeValue = { preset: tr.preset, range: tr.range, granularity: tr.granularity }

  useEffect(() => {
    void useDashboardStore.getState().reloadAll({
      start: tr.range ? tr.range[0] : null,
      end: tr.range ? tr.range[1] : null,
      granularity: tr.granularity
    })
  }, [tr.range, tr.granularity])

  // 本月收支：净额 = 收入 − 支出（均为正显示），方向 ↑青(流入主导)/↓橙(流出主导)
  const monthNet = metrics === null ? '0' : addDecimalStrings(metrics.monthIncome, negateDecimal(metrics.monthExpense))
  const monthNetUp = !monthNet.startsWith('-') && monthNet !== '0'
  const monthNetDown = monthNet.startsWith('-')
  // 净资产卡值颜色：正 = 文本色、负 = 红（colors.negative，红色语义唯一化）
  const netWorthNegative = metrics !== null && metrics.netWorth.startsWith('-')

  // 账本无数据 → 整页空态带行动（方案交互清单 4）
  if (!loading && !hasData) {
    return (
      <Empty description="账本暂无数据" style={{ marginTop: 80 }}>
        <Link to="/entry">
          <Button type="primary">去录入第一笔</Button>
        </Link>
      </Empty>
    )
  }

  return (
    <div>
      {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error} />}
      {/* 第一行：4 指标卡 */}
      <Row gutter={[16, 16]} className="dashboard-metrics">
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            {loading && metrics === null ? (
              <MetricSkeleton />
            ) : (
              <Statistic title="总资产" value={formatAmount(metrics?.assets)} />
            )}
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            {loading && metrics === null ? (
              <MetricSkeleton />
            ) : (
              <Statistic title="总负债" value={formatAmount(metrics?.liabilities)} />
            )}
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            {loading && metrics === null ? (
              <MetricSkeleton />
            ) : (
              <Statistic
                title="净资产"
                value={formatAmount(metrics?.netWorth)}
                valueStyle={{ color: netWorthNegative ? colors.negative : undefined }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card size="small">
            {loading && metrics === null ? (
              <MetricSkeleton />
            ) : (
              <Statistic
                title="本月收支"
                value={formatAmount(monthNet)}
                valueStyle={{ color: monthNetUp ? colors.inflow : monthNetDown ? colors.outflow : undefined }}
                suffix={
                  monthNetUp ? (
                    <ArrowUpOutlined style={{ color: colors.inflow }} />
                  ) : monthNetDown ? (
                    <ArrowDownOutlined style={{ color: colors.outflow }} />
                  ) : null
                }
              />
            )}
          </Card>
        </Col>
      </Row>
      {otherCurrencies.length > 0 && (
        <Typography.Text type="secondary" className="dashboard-other-currencies">
          其他币种资产：
          {otherCurrencies.map((c) => `${formatAmount(c.number)} ${c.currency}`).join(' / ')}
        </Typography.Text>
      )}

      {/* 第二行：收支对比 + 现金流量 */}
      <Row gutter={[16, 16]} className="dashboard-charts">
        <Col xs={24} lg={14}>
          <Card title="收支对比">
            {loading && incomeExpense.length === 0 ? (
              <Skeleton active title={false} paragraph={{ rows: 5 }} className="dashboard-trend-skeleton" />
            ) : (
              <LazyColumn
                data={buildIncomeExpenseData(incomeExpense)}
                xField="period"
                yField="value"
                colorField="type"
                theme={mode}
                height={240}
                style={{
                  color: [colors.inflow, colors.outflow]
                }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="近 12 个月现金流量">
            {loading && cashFlow.length === 0 ? (
              <Skeleton active title={false} paragraph={{ rows: 5 }} className="dashboard-trend-skeleton" />
            ) : (
              <LazyLine
                data={cashFlow.map((p) => ({ period: p.period, value: Number(p.net) }))}
                xField="period"
                yField="value"
                theme={mode}
                height={240}
                style={{
                  lineWidth: 2,
                  lineDash: [0, 0],
                  color: colors.primary
                }}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* 第三行：去向 + 来源 */}
      <Row gutter={[16, 16]} className="dashboard-charts">
        <Col xs={24} lg={12}>
          <Card title="支出去向">
            {loading && expenseBreakdown.length === 0 ? (
              <Skeleton active title={false} paragraph={{ rows: 4 }} className="dashboard-trend-skeleton" />
            ) : expenseBreakdown.length === 0 ? (
              <Typography.Text type="secondary">暂无支出数据</Typography.Text>
            ) : (
              <div className="dash-breakdown">
                {expenseBreakdown.map((it, i) => (
                  <BreakdownRow
                    key={it.category}
                    color={breakdownPalette[i % breakdownPalette.length]}
                    name={it.label ?? resolveCategoryName(it.category, accountNameMap)}
                    amount={it.amount}
                    ratio={it.ratio}
                  />
                ))}
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="收入来源">
            {loading && incomeBreakdown.length === 0 ? (
              <Skeleton active title={false} paragraph={{ rows: 4 }} className="dashboard-trend-skeleton" />
            ) : incomeBreakdown.length === 0 ? (
              <Typography.Text type="secondary">暂无收入数据</Typography.Text>
            ) : (
              <div className="dash-breakdown">
                {incomeBreakdown.map((it, i) => (
                  <BreakdownRow
                    key={it.category}
                    color={breakdownPalette[(i + 3) % breakdownPalette.length]}
                    name={it.label ?? resolveCategoryName(it.category, accountNameMap)}
                    amount={it.amount}
                    ratio={it.ratio}
                  />
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* 第四行：净资产趋势（带筛选条） */}
      <Card
        title="净资产趋势"
        className="dashboard-charts"
        extra={
          <TimeRangeBar
            value={rangeValue}
            showPresets={false}
            showGranularity
            onChange={(v) => {
              if (v.granularity !== tr.granularity) tr.setGranularity(v.granularity)
              else if (v.preset === 'custom') tr.setCustomRange(v.range)
              else tr.setPreset(v.preset)
            }}
          />
        }
      >
        {loading && series.length === 0 ? (
          <Skeleton active title={false} paragraph={{ rows: 5 }} className="dashboard-trend-skeleton" />
        ) : (
          <LazyLine
            data={buildNetWorthTrendData(series, prevYearSeries)}
            xField="period"
            yField="value"
            colorField="series"
            theme={mode}
            height={280}
            style={{
              lineWidth: 2,
              // G2 line 的 style 回调入参存在分组/单行两种形态：兼容取 series 字段
              lineDash: (d: unknown) => {
                const row = Array.isArray(d) ? (d[0] as { series?: string } | undefined) : (d as { series?: string } | undefined)
                return row?.series === '去年同期' ? [4, 4] : [0, 0]
              }
            }}
          />
        )}
      </Card>
    </div>
  )
}
