/**
 * 明细类表格的「金额」单元格（2026-09-16）：类型标签 + 类型着色的金额。
 *
 * 明细页与对账页明细账共用——两处原先各写一遍金额渲染，对账明细账那处漏了 `flowAmount` 兜底，
 * 导致借出/还款/转账行显示「—」（同一口径写两遍，必有一处漏），故此组件同时承担「口径单源」。
 *
 * 双重标记：颜色（`--bw-ink-*`，色编码**会计性质**）负责扫读，文字标签负责不依赖颜色也能读懂
 * （色觉障碍 / 灰度打印 / 类型图例）。标签 hover 给一句口径说明。
 */
import { Tooltip } from 'antd'
import type { LedgerEntryRow } from '../../../../shared/ipc'
import { TX_KIND_META, amountDisplay } from './entryRowDisplay'

interface AmountCellProps {
  row: Pick<LedgerEntryRow, 'amount' | 'currency' | 'flowAmount' | 'txKind'>
  /** 币种是否随金额显示：明细页 true（无独立币种列）；对账明细账另有币种列 → false */
  withCurrency?: boolean
}

export default function AmountCell({ row, withCurrency = true }: AmountCellProps) {
  const cell = amountDisplay(row, { withCurrency })
  if (!cell) return <>—</>
  const meta = cell.kind ? TX_KIND_META[cell.kind] : null
  return (
    <span className="amount-cell">
      {meta && (
        <Tooltip title={meta.hint}>
          <span className={`tx-kind tx-kind--${meta.tone}`}>{meta.label}</span>
        </Tooltip>
      )}
      <span className={`num${meta ? ` num--${meta.tone}` : ''}`}>{cell.text}</span>
    </span>
  )
}
