/**
 * Column 图表懒加载封装（批次 E 契约，批次 D DashboardPage 复用）：与 LazyLine 同款——
 * React.lazy 动态引入 @ant-design/charts + Suspense fallback Skeleton.Node（防布局跳变）。
 * props 透传，类型收窄为本仓库用法的最小面。
 */
import { lazy, Suspense } from 'react'
import { Skeleton } from 'antd'

const AntColumn = lazy(() => import('@ant-design/charts').then((m) => ({ default: m.Column })))

export interface LazyColumnProps {
  data: Array<Record<string, unknown>>
  xField: string
  yField: string
  colorField?: string
  height?: number
  /** G2 mark style（回调形态按 G2 约定） */
  style?: Record<string, unknown>
}

export default function LazyColumn(props: LazyColumnProps) {
  return (
    <Suspense
      fallback={<Skeleton.Node active style={{ width: '100%', height: props.height ?? 280 }} />}
    >
      <AntColumn {...props} />
    </Suspense>
  )
}
