/**
 * 账户页（批次 D Task 5，方案模块 4）：AccountSettingsModal 整体升级为页面。
 * 校验/删除限制/保存链路（getAccountConfig / saveAccountConfig）**逻辑原样搬移**，仅容器
 * 从 Modal 改页面：左侧五大类 Tabs（按 value 首段过滤；「全部」兜底避免未知首段条目不可见），
 * 右侧编辑表列原样（ID/名称/用途/路径/删除）；原新增区三 Input + 类型 Radio 收进页头
 * 「新增科目」Drawer（纵向排列替换 26%/30%/34% 定宽行），添加成功后关抽屉露出新行。
 * 批次 I 追加：① 状态列 Switch（enabled 缺省视为启用；切换仅改本地，随「保存」按钮
 * 显式落盘）；② 操作列「期初余额」（仅 Assets/Liabilities 行）→ Modal 输入金额/货币/日期
 * → buildOpeningBalanceEntry 组合 → 确认预览 → 既有 add-entry 通道写入（Equity:Opening-Balances
 * 配对，账本文件唯一事实源）→ refresh。
 */
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import {
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Drawer,
  Input,
  InputNumber,
  message,
  Modal,
  Radio,
  Space,
  Switch,
  Table,
  Tabs,
  Tooltip,
  Typography
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useEffect, useState } from 'react'
import type { AccountEntry, AddEntryParams } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import { formatAmount } from '../../utils/format'
import { buildOpeningBalanceEntry } from '../../utils/opening-balance'
import '../../styles/views/accounts.less'

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
  // 选择器只取稳定引用的 status（?? [] 兜底放渲染体——选择器内新建数组会因
  // getSnapshot 不稳定触发 React #185 无限重渲染，慢机器上 status 未就绪时必崩）
  const ledgerStatus = useLedgerStore((s) => s.status)
  const operatingCurrencies = ledgerStatus?.operatingCurrency ?? []
  const [configured, setConfigured] = useState<AccountEntry[]>([])
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newType, setNewType] = useState<AccountType>('Assets')
  const [saving, setSaving] = useState(false)
  const [usedValues, setUsedValues] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 批次 I 期初余额 Modal：null = 关闭；开启时记目标账户行 + 三输入
  const [obRecord, setObRecord] = useState<AccountEntry | null>(null)
  const [obAmount, setObAmount] = useState('')
  const [obCurrency, setObCurrency] = useState('')
  const [obDate, setObDate] = useState<Dayjs | null>(dayjs())

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

  // 启停用仅改本地条目，随「保存」按钮显式落盘（保持显式保存模型，避免误触即写盘）；
  // 重新启用写 undefined——序列化时省略，配置文件不存无谓的 enabled: true
  const handleEnabledChange = (id: number, checked: boolean) => {
    setConfigured((prev) => prev.map((e) => (e.id === id ? { ...e, enabled: checked ? undefined : false } : e)))
  }

  // ---- 批次 I：期初余额 ----
  const openObModal = (record: AccountEntry) => {
    setObRecord(record)
    setObAmount('')
    setObCurrency(operatingCurrencies[0] ?? '')
    setObDate(dayjs())
  }

  const handleObOk = async (): Promise<void> => {
    if (!obRecord) return
    const built = buildOpeningBalanceEntry({
      account: obRecord.value,
      number: obAmount.trim(),
      currency: obCurrency.trim(),
      date: (obDate ?? dayjs()).format('YYYY-MM-DD')
    })
    if ('error' in built) {
      message.error(built.error)
      throw new Error(built.error) // Modal onOk reject → 弹层不关，用户可改
    }
    setObRecord(null)
    Modal.confirm({
      title: '确认写入期初余额？',
      // 静态方法不消费 ConfigProvider 上下文（locale 缺省会渲染英文 OK/Cancel），显式指定中文
      okText: '确定',
      cancelText: '取消',
      width: 480,
      content: (
        <div style={{ marginTop: 8 }}>
          <Typography.Text>{built.date} * 「期初余额」</Typography.Text>
          {built.postings.map((p) => (
            <div key={p.account} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <span>{p.account}</span>
              <span className="num">
                {formatAmount(p.number)} {p.currency}
              </span>
            </div>
          ))}
          <Typography.Text type="secondary">将在账本新增一笔可编辑交易（Equity:Opening-Balances 配对，总账保持平衡）。</Typography.Text>
        </div>
      ),
      onOk: async () => {
        try {
          // 既有 add-entry 通道（唯一写路径）：未 open 账户主进程自动补 open 行
          const result = await window.beanwise.addLedgerEntry(built as AddEntryParams)
          if (!result.ok) {
            message.error(result.message ?? '写入失败')
            return
          }
          message.success('期初余额已写入账本')
          await useLedgerStore.getState().refresh()
        } catch (err) {
          message.error(`写入失败：${String(err)}`)
        }
      }
    })
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
                scroll={{ x: 'max-content' }}
                locale={{ emptyText: '暂无配置账户' }}
                columns={[
                  { title: 'ID', dataIndex: 'id', width: 48, render: (v: number) => v > 0 ? v : '新增' },
                  {
                    title: '名称',
                    dataIndex: 'name',
                    // width: 180,
                    render: (_: string, record: AccountEntry) =>
                      <Input size="small" value={record.name} onChange={(e) => handleNameChange(record.id, e.target.value)} maxLength={100} />
                  },
                  {
                    title: '用途',
                    dataIndex: 'description',
                    // width: 260,
                    render: (_: string, record: AccountEntry) =>
                      <Input size="small" value={record.description ?? ''} onChange={(e) => handleDescriptionChange(record.id, e.target.value)} maxLength={200} />
                  },
                  {
                    title: '状态',
                    dataIndex: 'enabled',
                    width: 72,
                    render: (_: boolean | undefined, record: AccountEntry) => (
                      <Tooltip title={record.enabled !== false ? '已启用（录入下拉可选）' : '已停用（录入下拉不可选，不影响历史明细）'}>
                        <Switch size="small" checked={record.enabled !== false} onChange={(checked) => handleEnabledChange(record.id, checked)} aria-label={`启停用 ${record.name}`} />
                      </Tooltip>
                    )
                  },
                  {
                    title: '路径',
                    dataIndex: 'value',
                    render: (v: string) => (
                      <Typography.Text className="account-path" code>{v}</Typography.Text>
                    )
                  },
                  {
                    title: '操作',
                    width: 130,
                    render: (_: unknown, record: AccountEntry) => {
                      const used = usedValues.has(record.value)
                      const type = record.value.split(':')[0]
                      const obEligible = type === 'Assets' || type === 'Liabilities'
                      return (
                        <Space size={0}>
                          {obEligible && (
                            <Tooltip title="录入期初余额">
                              <Button
                                type="link"
                                size="small"
                                onClick={() => openObModal(record)}
                                aria-label={`期初余额 ${record.name}`}
                              >
                                期初余额
                              </Button>
                            </Tooltip>
                          )}
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
                        </Space>
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
      <Modal
        title={`期初余额 — ${obRecord?.name ?? ''}`}
        open={obRecord !== null}
        onCancel={() => setObRecord(null)}
        onOk={() => void handleObOk()}
        okText="下一步"
        width={420}
        destroyOnHidden
      >
        <div className="account-add-form">
          <Typography.Text type="secondary">
            为 <Typography.Text code>{obRecord?.value}</Typography.Text> 录入期初余额，与 Equity:Opening-Balances 配对写入账本。
          </Typography.Text>
          <Space.Compact style={{ width: '100%' }}>
            <InputNumber
              stringMode
              controls={false}
              placeholder="金额 0.00"
              value={obAmount}
              onChange={(v) => setObAmount(v ?? '')}
              style={{ flex: 2 }}
              aria-label="期初余额金额"
            />
            <AutoComplete
              options={operatingCurrencies.map((c) => ({ value: c }))}
              placeholder="货币"
              value={obCurrency}
              onChange={(v) => setObCurrency(v)}
              style={{ flex: 1 }}
              aria-label="期初余额货币"
            />
          </Space.Compact>
          <DatePicker value={obDate} onChange={(d) => setObDate(d)} style={{ width: '100%' }} aria-label="期初余额日期" />
        </div>
      </Modal>
    </div>
  )
}
