/**
 * 新交易账户处理区块（M10 策略 C）：未映射支付方式键（新银行卡/新充值渠道）逐项处置。
 * 同一支付方式在交易类型不同时拆分为多条（支付方式@交易类型），可分别映射/排除。
 * fallback=保持兜底（默认，允许导入+强提示）；existing=归位已有账户；new=新建账户路径；
 * exclude=排除这些行（导入时过滤）。严格模式下存在 fallback 未处理项 → 阻塞导入。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { Input, Select, Tag, Typography } from 'antd'
import type { ExcelNewAccountInfo, NewAccountResolution } from '../../../../shared/ipc'
import type { AccountOption } from '../../stores/ledger'

interface Props {
  items: ExcelNewAccountInfo[]
  accountOptions: AccountOption[]
  resolutions: Record<string, NewAccountResolution>
  targets: Record<string, string>
  strict: boolean
  onChange(id: string, resolution: NewAccountResolution, target?: string): void
}

const RESOLUTION_LABEL: Record<NewAccountResolution, string> = {
  fallback: '保持兜底',
  existing: '归位到已有账户',
  new: '新建账户',
  exclude: '排除这些行'
}

const RESOLUTION_COLOR: Record<NewAccountResolution, string> = {
  fallback: 'orange',
  existing: 'green',
  new: 'blue',
  exclude: 'default'
}

export default function ExcelNewAccountSection({ items, accountOptions, resolutions, targets, strict, onChange }: Props) {
  if (items.length === 0) return null
  const fallbackCount = items.filter((n) => (resolutions[n.id] ?? 'fallback') === 'fallback').length

  const columns: ProColumns<ExcelNewAccountInfo>[] = [
    { title: '支付方式/键', dataIndex: 'key', width: 180 },
    { title: '交易类型（区分）', dataIndex: 'type', width: 160, render: (_dom: unknown, row: ExcelNewAccountInfo) => row.type || '—' },
    { title: '笔数', dataIndex: 'count', width: 64, align: 'right' },
    { title: '金额合计', dataIndex: 'amount', width: 100, align: 'right' },
    { title: '建议账户', dataIndex: 'suggestedAccount', ellipsis: true, render: (_dom: unknown, row: ExcelNewAccountInfo) => row.suggestedAccount || '—' },
    {
      title: '处理方式',
      width: 160,
      render: (_dom: unknown, item: ExcelNewAccountInfo) => {
        const res = resolutions[item.id] ?? 'fallback'
        return (
          <Select
            size="small"
            style={{ width: 150 }}
            value={res}
            onChange={(v: NewAccountResolution) => onChange(item.id, v)}
            options={(Object.keys(RESOLUTION_LABEL) as NewAccountResolution[]).map((r) => ({ value: r, label: RESOLUTION_LABEL[r] }))}
          />
        )
      }
    },
    {
      title: '目标账户',
      width: 260,
      render: (_dom: unknown, item: ExcelNewAccountInfo) => {
        const res = resolutions[item.id] ?? 'fallback'
        if (res === 'existing') {
          return (
            <Select
              size="small"
              style={{ width: 250 }}
              showSearch
              optionFilterProp="label"
              placeholder="选择已有账户"
              options={accountOptions}
              value={targets[item.id]}
              onChange={(v?: string) => onChange(item.id, res, v)}
            />
          )
        }
        if (res === 'new') {
          return (
            <Input
              size="small"
              style={{ width: 250 }}
              placeholder="如 Assets:Bank:ICBC"
              value={targets[item.id]}
              onChange={(e) => onChange(item.id, res, e.target.value)}
            />
          )
        }
        return <Typography.Text type="secondary">—</Typography.Text>
      }
    },
    {
      title: '状态',
      width: 110,
      render: (_dom: unknown, item: ExcelNewAccountInfo) => {
        const res = resolutions[item.id] ?? 'fallback'
        return <Tag color={RESOLUTION_COLOR[res]}>{RESOLUTION_LABEL[res]}</Tag>
      }
    }
  ]

  return (
    <div>
      <Typography.Text strong>新交易账户（未映射支付方式，同支付方式按交易类型拆分）</Typography.Text>
      {fallbackCount > 0 ? (
        <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8 }}>
          共 {fallbackCount} 个键未处理{strict ? '，严格模式下需全部处理才能导入' : '，导入时将记入兜底资产账户（可二次确认）'}。
        </Typography.Text>
      ) : null}
      <ProTable<ExcelNewAccountInfo> size="small" rowKey="id" dataSource={items} pagination={false} search={false} options={false} columns={columns} />
    </div>
  )
}
