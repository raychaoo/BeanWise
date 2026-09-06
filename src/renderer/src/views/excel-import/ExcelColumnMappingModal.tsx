/**
 * 通用 Excel 导入列映射设置（M10）。
 * Excel 列 → 标准字段（自动建议 + 手动微调）+ 方向判定规则 + 模板元信息。
 * 保存回调给 ExcelImportPanel，由面板统一经 excel:save-template 持久化。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { Button, Input, InputNumber, Modal, Radio, Select, Space, Switch, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type {
  ExcelDirectionMode,
  ExcelFieldMapping,
  ExcelImportTemplate
} from '../../../../shared/ipc'

interface Props {
  open: boolean
  sheets: string[]
  columns: string[]
  headerRow?: number
  suggested: ExcelFieldMapping | null
  /** 编辑已有模板时传入（预填 + id 保留）；新建传 null */
  existing: ExcelImportTemplate | null
  onSave: (template: ExcelImportTemplate) => void
  onClose: () => void
}

interface FieldRow {
  key: keyof ExcelFieldMapping
  label: string
  required?: boolean
}

const FIELDS: FieldRow[] = [
  { key: 'dateColumn', label: '日期列', required: true },
  { key: 'amountColumn', label: '金额列', required: true },
  { key: 'ioColumn', label: '方向列' },
  { key: 'typeColumn', label: '交易类型列' },
  { key: 'counterpartyColumn', label: '交易对方列' },
  { key: 'productColumn', label: '商品/摘要列' },
  { key: 'methodColumn', label: '支付方式列' },
  { key: 'statusColumn', label: '状态列' },
  { key: 'rowIdColumn', label: '单号列' },
  { key: 'noteColumn', label: '备注列' }
]

const MODE_LABEL: Record<ExcelDirectionMode, string> = {
  column: '按方向列（收/支、+/-、D/C）',
  amountSign: '按金额正负',
  keywords: '按关键词（充值/提现等为中性）'
}

function toTemplateIdHint(name: string): string {
  const s = name.trim().replace(/\s+/g, '-')
  return s ? `excel-${s}` : ''
}

export default function ExcelColumnMappingModal({
  open,
  sheets,
  columns,
  headerRow,
  suggested,
  existing,
  onSave,
  onClose
}: Props) {
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [sheetName, setSheetName] = useState<string | undefined>(undefined)
  const [header, setHeader] = useState<number | undefined>(undefined)
  const [mapping, setMapping] = useState<ExcelFieldMapping>({})
  const [mode, setMode] = useState<ExcelDirectionMode>('column')
  const [positiveAs, setPositiveAs] = useState<'income' | 'expense'>('income')
  const [neutralKeywords, setNeutralKeywords] = useState('')
  const [defaultKind, setDefaultKind] = useState<'expense' | 'income'>('expense')
  const [strict, setStrict] = useState(false)

  useEffect(() => {
    if (!open) return
    if (existing) {
      setName(existing.name)
      setSource(existing.source)
      setSheetName(existing.sheetName)
      setHeader(existing.headerRow)
      setMapping(existing.fieldMapping)
      setMode(existing.directionRule.mode)
      setPositiveAs(existing.directionRule.positiveAs ?? 'income')
      setNeutralKeywords((existing.directionRule.neutralKeywords ?? []).join('，'))
      setDefaultKind(existing.directionRule.defaultKind ?? 'expense')
      setStrict(existing.strictNewAccounts === true)
    } else {
      setName('')
      setSource('')
      setSheetName(undefined)
      setHeader(headerRow && headerRow > 0 ? headerRow : undefined)
      setMapping(suggested ?? {})
      setMode('column')
      setPositiveAs('income')
      setNeutralKeywords('')
      setDefaultKind('expense')
      setStrict(false)
    }
  }, [open, existing, suggested, headerRow])

  const columnOptions = columns.map((c) => ({ value: c, label: c }))

  const handleSave = () => {
    if (!name.trim()) {
      Modal.warning({ title: '请填写模板名称' })
      return
    }
    if (!mapping.dateColumn || !mapping.amountColumn) {
      Modal.warning({ title: '请指定日期列与金额列' })
      return
    }
    if (mode === 'column' && !mapping.ioColumn) {
      Modal.warning({ title: '按方向列模式需指定方向列' })
      return
    }
    const directionRule: ExcelImportTemplate['directionRule'] = {
      mode,
      ...(mode === 'amountSign' ? { positiveAs } : {}),
      ...(mode === 'keywords' ? { neutralKeywords: neutralKeywords.split(/[,，]/).map((k) => k.trim()).filter((k) => k !== ''), defaultKind } : {})
    }
    const template: ExcelImportTemplate = {
      id: existing?.id ?? '',
      name: name.trim(),
      source: source.trim() || existing?.source || toTemplateIdHint(name),
      ...(header && header > 0 ? { headerRow: header } : {}),
      ...(sheetName ? { sheetName } : {}),
      fieldMapping: mapping,
      directionRule,
      accountMapping: existing?.accountMapping ?? {
        expenseByType: {},
        incomeByType: {},
        sourceByMethod: {},
        cashAccountByMethod: {},
        fallbackExpenseAccount: 'Expenses:Uncategorized',
        fallbackSourceAccount: 'Assets:WeChat',
        fallbackIncomeAccount: 'Income:Other',
        fallbackCashAccount: 'Assets:WeChat'
      },
      strictNewAccounts: strict
    }
    onSave(template)
  }

  const columns2: ProColumns<FieldRow>[] = [
    { title: '标准字段', dataIndex: 'label', width: 160 },
    {
      title: 'Excel 列',
      dataIndex: 'key',
      render: (_dom: unknown, row: FieldRow) => (
        <Select
          style={{ width: '100%' }}
          allowClear
          showSearch
          options={columnOptions}
          value={mapping[row.key]}
          placeholder={row.required ? '必选' : '可选'}
          onChange={(v?: string) => setMapping((prev) => ({ ...prev, [row.key]: v }))}
        />
      )
    }
  ]

  return (
    <Modal
      title={existing ? '编辑列映射模板' : '新建列映射模板'}
      open={open}
      onCancel={onClose}
      width={720}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="save" type="primary" onClick={handleSave}>保存模板</Button>
      ]}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={14}>
        <Space size={12} wrap>
          <span>模板名称：</span>
          <Input style={{ width: 200 }} value={name} placeholder="如 招商银行信用卡" onChange={(e) => setName(e.target.value)} />
          <span>去重标识 source：</span>
          <Input style={{ width: 200 }} value={source} placeholder="留空自动生成" onChange={(e) => setSource(e.target.value)} />
        </Space>
        <Space size={12} wrap>
          <span>工作表：</span>
          <Select
            style={{ width: 200 }}
            allowClear
            placeholder="第一个工作表"
            options={sheets.map((s) => ({ value: s, label: s }))}
            value={sheetName}
            onChange={(v?: string) => setSheetName(v)}
          />
          <span>表头行：</span>
          <InputNumber min={0} value={header} placeholder="自动检测" onChange={(v) => setHeader(v ?? undefined)} style={{ width: 120 }} />
          <span>严格模式（未处理新账户阻塞导入）：</span>
          <Switch checked={strict} onChange={setStrict} />
        </Space>

        <Typography.Text type="secondary">
          列映射自动建议已按常见列名预填，可逐列调整；方向列/支付方式列可选但建议指定（关系到新交易账户检测）。
        </Typography.Text>
        <ProTable<FieldRow> size="small" rowKey="key" dataSource={FIELDS} pagination={false} search={false} options={false} columns={columns2} />

        <Space size={12} wrap>
          <span>方向判定：</span>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
            {(Object.keys(MODE_LABEL) as ExcelDirectionMode[]).map((m) => (
              <Radio key={m} value={m}>{MODE_LABEL[m]}</Radio>
            ))}
          </Radio.Group>
        </Space>
        {mode === 'amountSign' ? (
          <Space size={12} wrap>
            <span>金额为正表示：</span>
            <Radio.Group value={positiveAs} onChange={(e) => setPositiveAs(e.target.value)}>
              <Radio value="income">收入</Radio>
              <Radio value="expense">支出</Radio>
            </Radio.Group>
          </Space>
        ) : null}
        {mode === 'keywords' ? (
          <Space size={12} wrap>
            <span>中性关键词（逗号分隔）：</span>
            <Input style={{ width: 260 }} value={neutralKeywords} placeholder="充值,提现,互转" onChange={(e) => setNeutralKeywords(e.target.value)} />
            <span>未命中时默认：</span>
            <Radio.Group value={defaultKind} onChange={(e) => setDefaultKind(e.target.value)}>
              <Radio value="expense">支出</Radio>
              <Radio value="income">收入</Radio>
            </Radio.Group>
          </Space>
        ) : null}
      </Space>
    </Modal>
  )
}
