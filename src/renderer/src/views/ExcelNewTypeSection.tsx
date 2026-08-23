/**
 * 新交易类型键处理区块（按实际导入数据聚合的未映射类型键，M10 扩展）。
 * 同一交易类型在支付方式不同时拆分为多条（交易类型@支付方式），可分别映射/排除。
 * fallback=保持兜底（默认，允许导入+强提示）；mapped=按指定账户记账（默认建议账户，可改）；
 * exclude=排除这些行（导入时过滤）。严格模式下存在 fallback 未处理项 → 阻塞导入。
 */
import { Select, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ExcelNewTypeInfo, TypeMappingResolution } from '../../../shared/ipc'
import type { AccountOption } from '../stores/ledger'

interface Props {
  items: ExcelNewTypeInfo[]
  accountOptions: AccountOption[]
  resolutions: Record<string, TypeMappingResolution>
  targets: Record<string, string>
  strict: boolean
  onChange(id: string, resolution: TypeMappingResolution, target?: string): void
}

const RESOLUTION_LABEL: Record<TypeMappingResolution, string> = {
  mapped: '使用指定账户',
  fallback: '保持兜底',
  exclude: '排除这些行'
}

const RESOLUTION_COLOR: Record<TypeMappingResolution, string> = {
  mapped: 'green',
  fallback: 'orange',
  exclude: 'default'
}

const KIND_LABEL: Record<ExcelNewTypeInfo['kind'], string> = {
  expense: '支出',
  income: '收入/退款'
}

export default function ExcelNewTypeSection({ items, accountOptions, resolutions, targets, strict, onChange }: Props) {
  if (items.length === 0) return null
  const fallbackCount = items.filter((n) => (resolutions[n.id] ?? 'fallback') === 'fallback').length

  const columns: ColumnsType<ExcelNewTypeInfo> = [
    { title: '交易类型/键', dataIndex: 'key', width: 170 },
    { title: '支付方式（区分）', dataIndex: 'method', width: 170, render: (v: string) => v || '—' },
    { title: '方向', dataIndex: 'kind', width: 96, render: (v: ExcelNewTypeInfo['kind']) => <Tag color={v === 'expense' ? 'red' : 'green'}>{KIND_LABEL[v]}</Tag> },
    { title: '笔数', dataIndex: 'count', width: 64, align: 'right' },
    { title: '金额合计', dataIndex: 'amount', width: 100, align: 'right' },
    { title: '建议账户', dataIndex: 'suggestedAccount', ellipsis: true, render: (v: string) => v || '—' },
    {
      title: '处理方式',
      width: 160,
      render: (_: unknown, item: ExcelNewTypeInfo) => {
        const res = resolutions[item.id] ?? 'fallback'
        return (
          <Select
            size="small"
            style={{ width: 150 }}
            value={res}
            onChange={(v: TypeMappingResolution) => onChange(item.id, v)}
            options={(Object.keys(RESOLUTION_LABEL) as TypeMappingResolution[]).map((r) => ({ value: r, label: RESOLUTION_LABEL[r] }))}
          />
        )
      }
    },
    {
      title: '记账账户',
      width: 260,
      render: (_: unknown, item: ExcelNewTypeInfo) => {
        const res = resolutions[item.id] ?? 'fallback'
        if (res === 'mapped') {
          return (
            <Select
              size="small"
              style={{ width: 250 }}
              showSearch
              optionFilterProp="label"
              placeholder="选择记账账户"
              options={accountOptions}
              value={targets[item.id]}
              onChange={(v?: string) => onChange(item.id, res, v)}
            />
          )
        }
        return <Typography.Text type="secondary">—</Typography.Text>
      }
    },
    {
      title: '状态',
      width: 110,
      render: (_: unknown, item: ExcelNewTypeInfo) => {
        const res = resolutions[item.id] ?? 'fallback'
        return <Tag color={RESOLUTION_COLOR[res]}>{RESOLUTION_LABEL[res]}</Tag>
      }
    }
  ]

  return (
    <div>
      <Typography.Text strong>新交易类型（未映射的交易类型键，同类型按支付方式拆分）</Typography.Text>
      {fallbackCount > 0 ? (
        <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8 }}>
          共 {fallbackCount} 个键未处理{strict ? '，严格模式下需全部处理才能导入' : '，导入时将记入兜底账户（可二次确认）'}。
        </Typography.Text>
      ) : null}
      <Table<ExcelNewTypeInfo> size="small" rowKey="id" dataSource={items} pagination={false} columns={columns} />
    </div>
  )
}
