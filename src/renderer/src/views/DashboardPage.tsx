/**
 * 总览页（批次 D Task 3，方案模块 2）：4 × 指标卡（总资产/总负债/净资产/本月收支，运营货币）+
 * 净资产趋势卡（本期实线 + 去年同期虚线，图顶统一筛选条）。指标聚合走 useDashboardStore
 * （decimal 精确累加），Number() 仅图表 y 值显示层；每卡独立 Skeleton 防跳变。
 * 图表直接引入 @ant-design/charts Line（与 ReportsView 同款；批次 E 的 LazyLine 懒加载
 * 组件未合并，E 落地后可替换，不影响本页逻辑）。
 */
import { Line } from '@ant-design/charts'
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Empty, Row, Skeleton, Statistic, Typography } from 'antd'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import TimeRangeBar from '../components/TimeRangeBar'
import { useTimeRange } from '../hooks/useTimeRange'
import type { TimeRangeValue } from '../hooks/useTimeRange'
import { useDashboardStore } from '../stores/dashboard'
import { BW_COLORS } from '../theme/tokens'
import { formatAmount } from '../utils/format'
import { addDecimalStrings, negateDecimal } from '../../../shared/decimal'
import type { NetWorthPoint } from '../../../shared/ipc'
import '../styles/views/dashboard.less'

/** 期号回退一年：'2026-08' → '2025-08'，'2026' → '2025'（期号非金额，显示层字符串处理） */
function prevPeriod(period: string): string {
  const dash = period.indexOf('-')
  const year = Number(period.slice(0, dash === -1 ? period.length : dash)) - 1
  return `${year}${dash === -1 ? '' : period.slice(dash)}`
}

/** 趋势图数据（显示层 Number）：本期实线点 + 去年同期虚线点对齐同一期号 */
function buildTrendData(
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

/** 指标卡骨架：高度对齐 Statistic（防跳变，方案交互清单 5） */
function MetricSkeleton() {
  return <Skeleton active title={false} paragraph={{ rows: 1 }} className="dash-metric-skeleton" />
}

export default function DashboardPage() {
  const loading = useDashboardStore((s) => s.loading)
  const error = useDashboardStore((s) => s.error)
  const metrics = useDashboardStore((s) => s.metrics)
  const series = useDashboardStore((s) => s.series)
  const prevYearSeries = useDashboardStore((s) => s.prevYearSeries)
  const otherCurrencies = useDashboardStore((s) => s.otherCurrencies)
  const hasData = useDashboardStore((s) => s.hasData)

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
  // 净资产卡值颜色：正 = 文本色、负 = 红（BW_COLORS.negative，红色语义唯一化）
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
                valueStyle={{ color: netWorthNegative ? BW_COLORS.negative : undefined }}
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
                valueStyle={{ color: monthNetUp ? BW_COLORS.inflow : monthNetDown ? BW_COLORS.outflow : undefined }}
                suffix={
                  monthNetUp ? (
                    <ArrowUpOutlined style={{ color: BW_COLORS.inflow }} />
                  ) : monthNetDown ? (
                    <ArrowDownOutlined style={{ color: BW_COLORS.outflow }} />
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
      <Card
        title="净资产趋势"
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
          <Line
            data={buildTrendData(series, prevYearSeries)}
            xField="period"
            yField="value"
            colorField="series"
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
