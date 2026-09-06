/**
 * 通用 Excel 导入的账户映射设置（M10，模板内编辑）。
 * 账户映射模型：交易类型键 → 支出/收入账户，支付方式键 → 来源/现金账户 + 兜底。
 * 差异：不直接经 IPC 持久化，由 ExcelImportPanel 在保存模板时统一落盘。
 * 账户列用下拉选择（与录入页「记账行」一致）：选项 = 账户库 + 账本历史账户，并并入当前已填值，
 * 保证已存映射即使不在账户库中也能显示/保留。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
import { Button, Input, message, Modal, Select, Space, Typography } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import type { AccountMappingConfig } from '../../../../shared/ipc'
import type { AccountOption } from '../../stores/ledger'

interface Props {
  open: boolean
  accountMapping: AccountMappingConfig | null
  accountOptions: AccountOption[]
  onSave: (accountMapping: AccountMappingConfig) => void
  onClose: () => void
}

interface MappingRow {
  key: string
  label: string
  value: string
}

const ACCOUNT_RE = /^[A-Z]\S*:\S*$/

export default function ExcelAccountMappingModal({ open, accountMapping, accountOptions, onSave, onClose }: Props) {
  const [expenseRows, setExpenseRows] = useState<MappingRow[]>([])
  const [incomeRows, setIncomeRows] = useState<MappingRow[]>([])
  const [sourceRows, setSourceRows] = useState<MappingRow[]>([])
  const [cashRows, setCashRows] = useState<MappingRow[]>([])
  const [fallbackExpense, setFallbackExpense] = useState('Expenses:Uncategorized')
  const [fallbackSource, setFallbackSource] = useState('Assets:WeChat')
  const [fallbackIncome, setFallbackIncome] = useState('Income:Other')
  const [fallbackCash, setFallbackCash] = useState('Assets:WeChat')
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    if (!open || !accountMapping) return
    setKeyword('')
    setExpenseRows(Object.entries(accountMapping.expenseByType).map(([label, value]) => ({ key: label, label, value })))
    setIncomeRows(Object.entries(accountMapping.incomeByType ?? {}).map(([label, value]) => ({ key: label, label, value })))
    setSourceRows(Object.entries(accountMapping.sourceByMethod).map(([label, value]) => ({ key: label, label, value })))
    setCashRows(Object.entries(accountMapping.cashAccountByMethod ?? {}).map(([label, value]) => ({ key: label, label, value })))
    setFallbackExpense(accountMapping.fallbackExpenseAccount)
    setFallbackSource(accountMapping.fallbackSourceAccount)
    setFallbackIncome(accountMapping.fallbackIncomeAccount)
    setFallbackCash(accountMapping.fallbackCashAccount)
  }, [open, accountMapping])

  /** 下拉选项：账户库 + 账本历史账户，并并入当前已填值（旧映射不在账户库中也能显示/保留） */
  const accountSelectOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: AccountOption[] = []
    const push = (value: string) => {
      const v = value.trim()
      if (!v || seen.has(v)) return
      seen.add(v)
      out.push(accountOptions.find((o) => o.value === v) ?? { label: v, value: v })
    }
    for (const rows of [expenseRows, incomeRows, sourceRows, cashRows]) {
      for (const r of rows) push(r.value)
    }
    push(fallbackExpense)
    push(fallbackIncome)
    push(fallbackSource)
    push(fallbackCash)
    for (const o of accountOptions) push(o.value)
    return out
  }, [accountOptions, expenseRows, incomeRows, sourceRows, cashRows, fallbackExpense, fallbackIncome, fallbackSource, fallbackCash])

  const validate = (next: AccountMappingConfig): boolean => {
    const check = (rows: MappingRow[], title: string): boolean => {
      for (const r of rows) {
        if (r.label.trim() !== '' && !ACCOUNT_RE.test(r.value.trim())) {
          message.error(`${title} ${r.label} 格式非法`)
          return false
        }
      }
      return true
    }
    if (!check(expenseRows, '支出账户')) return false
    if (!check(incomeRows, '收入账户')) return false
    if (!check(sourceRows, '来源账户')) return false
    if (!check(cashRows, '现金账户')) return false
    if (!ACCOUNT_RE.test(fallbackExpense.trim())) { message.error('兜底支出账户格式非法'); return false }
    if (!ACCOUNT_RE.test(fallbackSource.trim())) { message.error('兜底来源账户格式非法'); return false }
    if (!ACCOUNT_RE.test(fallbackIncome.trim())) { message.error('兜底收入账户格式非法'); return false }
    if (!ACCOUNT_RE.test(fallbackCash.trim())) { message.error('兜底现金账户格式非法'); return false }
    return true
  }

  const handleSave = () => {
    const next: AccountMappingConfig = {
      expenseByType: Object.fromEntries(expenseRows.filter((r) => r.label.trim() !== '').map((r) => [r.label.trim(), r.value.trim()])),
      incomeByType: Object.fromEntries(incomeRows.filter((r) => r.label.trim() !== '').map((r) => [r.label.trim(), r.value.trim()])),
      sourceByMethod: Object.fromEntries(sourceRows.filter((r) => r.label.trim() !== '').map((r) => [r.label.trim(), r.value.trim()])),
      cashAccountByMethod: Object.fromEntries(cashRows.filter((r) => r.label.trim() !== '').map((r) => [r.label.trim(), r.value.trim()])),
      fallbackExpenseAccount: fallbackExpense.trim(),
      fallbackSourceAccount: fallbackSource.trim(),
      fallbackIncomeAccount: fallbackIncome.trim(),
      fallbackCashAccount: fallbackCash.trim()
    }
    if (!validate(next)) return
    onSave(next)
    onClose()
  }

  const expenseColumns: ProColumns<MappingRow>[] = [
    { title: '交易类型/键', dataIndex: 'label', width: 200 },
    {
      title: '支出账户',
      dataIndex: 'value',
      render: (_dom: unknown, row: MappingRow) => (
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="选择支出账户"
          options={accountSelectOptions}
          value={row.value}
          onChange={(v) => setExpenseRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, value: v } : r)))}
        />
      )
    }
  ]
  const sourceColumns: ProColumns<MappingRow>[] = [
    { title: '支付方式/键', dataIndex: 'label', width: 200 },
    {
      title: '来源账户',
      dataIndex: 'value',
      render: (_dom: unknown, row: MappingRow) => (
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="选择来源账户"
          options={accountSelectOptions}
          value={row.value}
          onChange={(v) => setSourceRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, value: v } : r)))}
        />
      )
    }
  ]
  const incomeColumns: ProColumns<MappingRow>[] = [
    { title: '收入/退款键', dataIndex: 'label', width: 200 },
    {
      title: '收入账户',
      dataIndex: 'value',
      render: (_dom: unknown, row: MappingRow) => (
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="选择收入账户"
          options={accountSelectOptions}
          value={row.value}
          onChange={(v) => setIncomeRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, value: v } : r)))}
        />
      )
    }
  ]
  const cashColumns: ProColumns<MappingRow>[] = [
    { title: '支付方式/键', dataIndex: 'label', width: 200 },
    {
      title: '现金账户',
      dataIndex: 'value',
      render: (_dom: unknown, row: MappingRow) => (
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          placeholder="选择现金账户"
          options={accountSelectOptions}
          value={row.value}
          onChange={(v) => setCashRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, value: v } : r)))}
        />
      )
    }
  ]

  /** 按键搜索：交易类型/键、收入/退款键、支付方式/键 */
  const filterByKeyword = (rows: MappingRow[]): MappingRow[] => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return rows
    return rows.filter((r) => r.label.toLowerCase().includes(kw))
  }

  return (
    <Modal
      title="Excel 导入账户映射"
      open={open}
      onCancel={onClose}
      width={820}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="save" type="primary" onClick={handleSave}>保存</Button>
      ]}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={14}>
        <Typography.Text type="secondary">
          按导入行的「交易类型/键 → 支出/收入账户、支付方式/键 → 来源/现金账户」记账；未匹配使用兜底账户。
          新出现的银行卡/充值渠道建议在预览的「新交易账户」区块处理，或在此预先补映射。
        </Typography.Text>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索交易类型/键、支付方式/键"
          style={{ width: 300 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <ProTable<MappingRow> size="small" rowKey="key" dataSource={filterByKeyword(expenseRows)} pagination={false} search={false} options={false} columns={expenseColumns} />
        <ProTable<MappingRow> size="small" rowKey="key" dataSource={filterByKeyword(incomeRows)} pagination={false} search={false} options={false} columns={incomeColumns} />
        <ProTable<MappingRow> size="small" rowKey="key" dataSource={filterByKeyword(sourceRows)} pagination={false} search={false} options={false} columns={sourceColumns} />
        <ProTable<MappingRow> size="small" rowKey="key" dataSource={filterByKeyword(cashRows)} pagination={false} search={false} options={false} columns={cashColumns} />
        <Space size={12} wrap>
          <span>兜底支出：</span>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 240 }}
            placeholder="选择兜底支出账户"
            options={accountSelectOptions}
            value={fallbackExpense}
            onChange={setFallbackExpense}
          />
          <span>兜底收入：</span>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 240 }}
            placeholder="选择兜底收入账户"
            options={accountSelectOptions}
            value={fallbackIncome}
            onChange={setFallbackIncome}
          />
          <span>兜底来源：</span>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 240 }}
            placeholder="选择兜底来源账户"
            options={accountSelectOptions}
            value={fallbackSource}
            onChange={setFallbackSource}
          />
          <span>兜底现金：</span>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 240 }}
            placeholder="选择兜底现金账户"
            options={accountSelectOptions}
            value={fallbackCash}
            onChange={setFallbackCash}
          />
        </Space>
      </Space>
    </Modal>
  )
}
