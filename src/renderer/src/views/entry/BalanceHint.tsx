/**
 * 平衡指示条（批次 B Task 3，方案模块 3）：绿色「借贷已平衡」/ 红色「差额/将自动平衡为 X」，
 * 无状态不渲染。状态计算在 balanceHint.ts 纯函数（node 单测覆盖）。
 */
import { CheckCircleFilled, WarningFilled } from '@ant-design/icons'
import { balanceHintState } from './balanceState'

interface Props {
  rows: Array<{ number?: string | null } | undefined> | undefined
}

export default function BalanceHint({ rows }: Props) {
  const state = balanceHintState(rows)
  if (state.kind === 'none') return null
  return (
    <div className={`balance-hint balance-hint--${state.kind}`} role="status">
      {state.kind === 'balanced' ? <CheckCircleFilled /> : <WarningFilled />}
      <span>{state.text}</span>
    </div>
  )
}
