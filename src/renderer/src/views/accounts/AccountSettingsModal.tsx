/**
 * @deprecated 批次 D 起账户管理迁至独立页面 /accounts（views/AccountsPage.tsx，逻辑原样搬移），
 * 录入页「账户设置」按钮已改为路由跳转；本文件暂无引用，留待下个清理批次删除。
 */
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Input, message, Modal, Radio, Space, Table, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { AccountEntry } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'

interface Props {
  open: boolean
  onClose: () => void
}

const ACCOUNT_RE = /^[A-Z]\S*:\S*$/
const ACCOUNT_TYPES = ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'] as const
const ACCOUNT_TYPE_LABELS = {
  Assets: '资产',
  Liabilities: '负债',
  Equity: '权益',
  Income: '收入',
  Expenses: '支出'
} as const
const ROOT_RE = /^(Assets|Liabilities|Equity|Income|Expenses):/

type AccountType = typeof ACCOUNT_TYPES[number]

export default function AccountSettingsModal({ open, onClose }: Props) {
  const saveAccountConfig = useLedgerStore((s) => s.saveAccountConfig)
  const [configured, setConfigured] = useState<AccountEntry[]>([])
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newType, setNewType] = useState<AccountType>('Assets')
  const [saving, setSaving] = useState(false)
  const [usedValues, setUsedValues] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const [r, ledger] = await Promise.all([
          window.beanwise.getAccountConfig(),
          window.beanwise.listLedgerAccounts()
        ])
        setConfigured((r.accounts ?? []).map((a) => ({ ...a, description: a.description ?? '' })))
        setUsedValues(new Set(ledger.accounts))
      } catch {
        setConfigured([])
        setUsedValues(new Set())
      }
    })()
  }, [open])

  const handleAdd = () => {
    const name = newName.trim()
    const description = newDescription.trim()
    const raw = newValue.trim()
    if (!name) { message.error('请输入账户名称'); return }
    if (!raw) { message.error('请输入账户路径'); return }

    // 路径已带类型前缀时必须与所选类型一致；否则自动拼接所选类型
    const rootMatch = ROOT_RE.exec(raw)
    let value: string
    if (rootMatch) {
      if (rootMatch[1] !== newType) {
        message.error(`所选类型为 ${newType}，路径却以 ${rootMatch[1]} 开头`)
        return
      }
      value = raw
    } else {
      value = `${newType}:${raw.replace(/^:+/, '')}`
    }

    if (!ACCOUNT_RE.test(value)) {
      message.error('账户路径格式：大写字母开头、含冒号、无空格，如 Assets:Bank:CNB')
      return
    }
    if (configured.some((e) => e.value === value)) {
      message.error('该账户路径已存在')
      return
    }
    // 新条目 id=0 表示"待主进程分配自增 id"
    setConfigured((prev) => [...prev, { id: 0, name, value, description }])
    setNewName('')
    setNewDescription('')
    setNewValue('')
  }

  const handleNameChange = (id: number, name: string) => {
    setConfigured((prev) => prev.map((e) => (e.id === id ? { ...e, name } : e)))
  }

  const handleDescriptionChange = (id: number, description: string) => {
    setConfigured((prev) => prev.map((e) => (e.id === id ? { ...e, description } : e)))
  }

  const handleDelete = async (id: number) => {
    const record = configured.find((e) => e.id === id)
    if (!record) return
    const ledger = await window.beanwise.listLedgerAccounts()
    if (ledger.accounts.includes(record.value)) {
      message.error('该账户已有记账记录，不可删除')
      return
    }
    setConfigured((prev) => prev.filter((e) => e.id !== id))
  }

  const handleSave = async () => {
    const empty = configured.find((e) => !e.name.trim())
    if (empty) { message.error('账户名称不能为空'); return }
    setSaving(true)
    const ok = await saveAccountConfig(configured.map((e) => ({ ...e, description: e.description ?? '' })))
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <Modal
      title="账户设置"
      open={open}
      onCancel={onClose}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="save" type="primary" loading={saving} onClick={() => void handleSave()}>保存</Button>
      ]}
      width={760}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Table<AccountEntry>
          size="small"
          dataSource={configured}
          rowKey="id"
          pagination={false}
          locale={{ emptyText: '暂无配置账户' }}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 48, render: (v: number) => v > 0 ? v : '新增' },
            {
              title: '名称',
              dataIndex: 'name',
              width: 160,
              render: (_: string, record: AccountEntry) =>
                <Input size="small" value={record.name} onChange={(e) => handleNameChange(record.id, e.target.value)} maxLength={100} />
            },
            {
              title: '用途',
              dataIndex: 'description',
              width: 200,
              render: (_: string, record: AccountEntry) =>
                <Input size="small" value={record.description ?? ''} onChange={(e) => handleDescriptionChange(record.id, e.target.value)} maxLength={200} />
            },
            { title: '路径', dataIndex: 'value', ellipsis: true },
            {
              title: '',
              width: 48,
              render: (_: unknown, record: AccountEntry) => {
                const used = usedValues.has(record.value)
                return (
                  <Tooltip title={used ? '已有记账记录，不可删除' : '删除账户'}>
                    <span>
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        disabled={used}
                        onClick={() => void handleDelete(record.id)}
                        aria-label={`删除 ${record.name}`}
                      />
                    </span>
                  </Tooltip>
                )
              }
            }
          ]}
        />
        <Space size={8} wrap>
          <Typography.Text>账户类型</Typography.Text>
          <Radio.Group
            value={newType}
            onChange={(e) => setNewType(e.target.value as AccountType)}
            options={ACCOUNT_TYPES.map((t) => ({ label: ACCOUNT_TYPE_LABELS[t], value: t }))}
          />
        </Space>
        <Space.Compact style={{ width: '100%' }}>
          <Input placeholder="名称（中文）" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} style={{ width: '26%' }} />
          <Input placeholder="用途" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} maxLength={200} style={{ width: '30%' }} />
          <Input placeholder="路径 如 Bank:CNB" value={newValue} onChange={(e) => setNewValue(e.target.value)} maxLength={200} style={{ width: '34%' }} />
          <Button type="dashed" icon={<PlusOutlined />} onClick={handleAdd}>添加</Button>
        </Space.Compact>
      </Space>
    </Modal>
  )
}
