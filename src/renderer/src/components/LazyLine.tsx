/**
 * Line 图表懒加载封装（批次 E 契约，批次 D DashboardPage 复用）：
 * React.lazy 动态引入 @ant-design/charts——图表包（G2 体积大头）不进首屏 chunk，
 * 报表/总览页首帧无需等待其解析；Suspense fallback = Skeleton.Node（高度对齐图表 280px，
 * 方案交互清单 5 防布局跳变）。props 透传，类型收窄为本仓库两处用法的最小面
 * （data/xField/yField/colorField/height/style，Number() 仅图表 y 值显示层）。
 */
import { lazy, Suspense } from 'react'
import { Skeleton } from 'antd'

const AntLine = lazy(() => import('@ant-design/charts').then((m) => ({ default: m.Line })))

export interface LazyLineProps {
  data: Array<Record<string, unknown>>
  xField: string
  yField: string
  colorField?: string
  height?: number
  /** G2 mark style（线宽/虚线等；回调形态按 G2 约定） */
  style?: Record<string, unknown>
}

export default function LazyLine(props: LazyLineProps) {
  return (
    <Suspense
      fallback={<Skeleton.Node active style={{ width: '100%', height: props.height ?? 280 }} />}
    >
      <AntLine {...props} />
    </Suspense>
  )
}
