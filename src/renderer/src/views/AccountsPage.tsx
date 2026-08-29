/**
 * 账户页（批次 D Task 5，方案模块 4）：AccountSettingsModal 整体升级为页面。
 * 校验/删除限制/保存链路（getAccountConfig / saveAccountConfig）**逻辑原样搬移**，仅容器
 * 从 Modal 改页面：左侧五大类 Tabs（按 value 首段过滤；「全部」兜底避免未知首段条目不可见），
 * 右侧编辑表列原样（ID/名称/用途/路径/删除）；原新增区三 Input + 类型 Radio 收进页头
 * 「新增科目」Drawer（纵向排列替换 26%/30%/34% 定宽行），添加成功后关抽屉露出新行。
 */
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Card, Drawer, Input, message, Radio, Space, Table, Tabs, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { AccountEntry } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'
import '../styles/views/accounts.less'

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
type TabKey = 'all' | AccountType

const TAB_ITEMS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: '全部' },
  ...ACCOUNT_TYPES.map((t) => ({ key: t as TabKey, label: ACCOUNT_TYPE_LABELS[t] }))
]

export default function AccountsPage() {
  const saveAccountConfig = useLedgerStore((s) => s.saveAccountConfig)
  const [configured, setConfigured] = useState<AccountEntry[]>([])
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newType, setNewType] = useState<AccountType>('Assets')
  const [saving, setSaving] = useState(false)
  const [usedValues, setUsedValues] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
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
  }, [])

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
    setDrawerOpen(false)
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
    if (ok) message.success('账户配置已保存')
  }

  const filtered = activeTab === 'all' ? configured : configured.filter((e) => e.value.split(':')[0] === activeTab)

  return (
    <div className="accounts-view">
      <Card
        title="科目管理"
        extra={
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>新增科目</Button>
            <Button type="primary" loading={saving} onClick={() => void handleSave()}>保存</Button>
          </Space>
        }
      >
        <Tabs
          tabPosition="left"
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as TabKey)}
          items={TAB_ITEMS.map((t) => ({
            key: t.key,
            label: t.label,
            children: (
              <Table<AccountEntry>
                size="small"
                dataSource={filtered}
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
            )
          }))}
        />
      </Card>
      <Drawer
        title="新增科目"
        width={420}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnHidden
      >
        <div className="account-add-form">
          <Space size={8} wrap>
            <Typography.Text>账户类型</Typography.Text>
            <Radio.Group
              value={newType}
              onChange={(e) => setNewType(e.target.value as AccountType)}
              options={ACCOUNT_TYPES.map((t) => ({ label: ACCOUNT_TYPE_LABELS[t], value: t }))}
            />
          </Space>
          <Input placeholder="名称（中文）" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} />
          <Input placeholder="用途" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} maxLength={200} />
          <Input placeholder="路径 如 Bank:CNB" value={newValue} onChange={(e) => setNewValue(e.target.value)} maxLength={200} />
          <Button type="dashed" icon={<PlusOutlined />} onClick={handleAdd}>添加</Button>
        </div>
      </Drawer>
    </div>
  )
}
