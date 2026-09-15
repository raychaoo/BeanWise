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
 * 性能：科目多时切 tab 卡顿——六个 pane 各挂一张全量表，且 items/columns/dataSource 均为
 * 渲染体内联新建，导致每次切换都重渲染**所有已挂载 pane** 的全量行（行内 Input/Switch/Tooltip）。
 * 现按 tab 各自持有数据（useTabData，未变化的 tab 沿用旧数组引用）+ AccountsTable memo 化
 * + handlers useCallback 稳定引用，未变化的 pane 整棵跳过，切换只付首次挂载成本。
 */
import { ProTable } from '@ant-design/pro-components'
import type { ProColumns } from '@ant-design/pro-components'
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
  Tabs,
  Tooltip,
  Typography
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACCOUNT_TYPES, type AccountType } from '../../../../shared/account'
import type { AccountEntry, AddEntryParams } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import {
  groupAccountsByTab,
  reuseUnchangedTabs,
  type AccountTabData,
  type AccountTabKey
} from '../../utils/accountTabs'
import { formatAmount } from '../../utils/format'
import { buildOpeningBalanceEntry } from '../../utils/opening-balance'
import '../../styles/views/accounts.less'

const ACCOUNT_RE = /^[A-Z]\S*:\S*$/
const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  Assets: '资产',
  Liabilities: '负债',
  Equity: '权益',
  Income: '收入',
  Expenses: '支出'
}
const ROOT_RE = /^(Assets|Liabilities|Equity|Income|Expenses):/

type TabKey = AccountTabKey

const TAB_ITEMS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: '全部' },
  ...ACCOUNT_TYPES.map((t) => ({ key: t as TabKey, label: ACCOUNT_TYPE_LABELS[t] }))
]

const EMPTY_STRINGS: string[] = []
const EMPTY_TAB_DATA: AccountTabData = groupAccountsByTab([])
const TABLE_LOCALE = { emptyText: '暂无配置账户' }

/**
 * 每个 tab 一份数据，且未变化的 tab 沿用旧数组引用（见 utils/accountTabs）——
 * 引用稳定是下面 memo 表格能跳过渲染的前提。
 */
function useTabData(configured: AccountEntry[]): AccountTabData {
  const cacheRef = useRef<AccountTabData>(EMPTY_TAB_DATA)
  return useMemo(() => {
    const next = reuseUnchangedTabs(cacheRef.current, groupAccountsByTab(configured))
    cacheRef.current = next
    return next
  }, [configured])
}

interface AccountsTableProps {
  data: AccountEntry[]
  usedValues: Set<string>
  onNameChange: (id: number, name: string) => void
  onDescriptionChange: (id: number, description: string) => void
  onEnabledChange: (id: number, checked: boolean) => void
  onCounterpartyChange: (id: number, checked: boolean) => void
  onDelete: (record: AccountEntry) => void
  onOpeningBalance: (record: AccountEntry) => void
}

/**
 * 单个 tab 的科目表（列定义原样搬移）。
 * memo 是性能关键：Tabs 每次切换都会重建 items 里的 children 元素，六个 pane 各挂一张全量表；
 * props 不稳定时每次切换都会重渲染所有**已挂载**的 pane（行内是 Input/Switch/Tooltip/Button，
 * 几百行即明显卡顿）。data/usedValues/handlers 稳定后未变化的 pane 直接跳过渲染，
 * 切换只付「首次挂载该 tab」的成本。
 */
const AccountsTable = memo(function AccountsTable({
  data,
  usedValues,
  onNameChange,
  onDescriptionChange,
  onEnabledChange,
  onCounterpartyChange,
  onDelete,
  onOpeningBalance
}: AccountsTableProps) {
  // 列只随 handlers / usedValues 重建；否则 ProTable 每次渲染都要把列定义重新处理一遍
  const columns = useMemo<ProColumns<AccountEntry>[]>(
    () => [
      { title: 'ID', dataIndex: 'id', width: 48, render: (_dom: unknown, record: AccountEntry) => record.id > 0 ? record.id : '新增' },
      {
        title: '名称',
        dataIndex: 'name',
        render: (_dom: unknown, record: AccountEntry) =>
          <Input size="small" value={record.name} onChange={(e) => onNameChange(record.id, e.target.value)} maxLength={100} />
      },
      {
        title: '用途',
        dataIndex: 'description',
        render: (_dom: unknown, record: AccountEntry) =>
          <Input size="small" value={record.description ?? ''} onChange={(e) => onDescriptionChange(record.id, e.target.value)} maxLength={200} />
      },
      {
        title: '状态',
        dataIndex: 'enabled',
        width: 72,
        render: (_dom: unknown, record: AccountEntry) => (
          <Tooltip title={record.enabled !== false ? '已启用（录入下拉可选）' : '已停用（录入下拉不可选，不影响历史明细）'}>
            <Switch size="small" checked={record.enabled !== false} onChange={(checked) => onEnabledChange(record.id, checked)} aria-label={`启停用 ${record.name}`} />
          </Tooltip>
        )
      },
      {
        title: '往来',
        dataIndex: 'counterparty',
        width: 72,
        render: (_dom: unknown, record: AccountEntry) => {
          const type = record.value.split(':')[0]
          if (type !== 'Assets' && type !== 'Liabilities') {
            return <Typography.Text type="secondary">—</Typography.Text>
          }
          return (
            <Tooltip title={record.counterparty === true ? '往来类账户：录入时填「往来对象」，参与往来账报表' : '非往来类账户（不参与往来账报表）'}>
              <Switch size="small" checked={record.counterparty === true} onChange={(checked) => onCounterpartyChange(record.id, checked)} aria-label={`往来类 ${record.name}`} />
            </Tooltip>
          )
        }
      },
      {
        title: '路径',
        dataIndex: 'value',
        render: (_dom: unknown, record: AccountEntry) => (
          <Typography.Text className="account-path" code>{record.value}</Typography.Text>
        )
      },
      {
        title: '操作',
        width: 130,
        render: (_dom: unknown, record: AccountEntry) => {
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
                    onClick={() => onOpeningBalance(record)}
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
                    onClick={() => onDelete(record)}
                    aria-label={`删除 ${record.name}`}
                  />
                </span>
              </Tooltip>
            </Space>
          )
        }
      }
    ],
    [usedValues, onNameChange, onDescriptionChange, onEnabledChange, onCounterpartyChange, onDelete, onOpeningBalance]
  )

  return (
    <ProTable<AccountEntry>
      size="small"
      dataSource={data}
      rowKey="id"
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={TABLE_LOCALE}
      search={false}
      options={false}
      columns={columns}
    />
  )
})

export default function AccountsPage() {
  const saveAccountConfig = useLedgerStore((s) => s.saveAccountConfig)
  // 选择器只取稳定引用的 status（?? [] 兜底放渲染体——选择器内新建数组会因
  // getSnapshot 不稳定触发 React #185 无限重渲染，慢机器上 status 未就绪时必崩）
  const ledgerStatus = useLedgerStore((s) => s.status)
  // 引用稳定：下面 useCallback / memo 表格都依赖它，每次新建 [] 会让 memo 全部失效
  const operatingCurrencies = useMemo(() => ledgerStatus?.operatingCurrency ?? EMPTY_STRINGS, [ledgerStatus])
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

  // 下面几个 handler 直接作为 memo 表格的 props → 一律 useCallback 稳定引用，
  // 否则表格每次页面重渲染都判定 props 变化，等于 memo 失效
  const handleNameChange = useCallback((id: number, name: string) => {
    setConfigured((prev) => prev.map((e) => (e.id === id ? { ...e, name } : e)))
  }, [])

  const handleDescriptionChange = useCallback((id: number, description: string) => {
    setConfigured((prev) => prev.map((e) => (e.id === id ? { ...e, description } : e)))
  }, [])

  // 启停用仅改本地条目，随「保存」按钮显式落盘（保持显式保存模型，避免误触即写盘）；
  // 重新启用写 undefined——序列化时省略，配置文件不存无谓的 enabled: true
  const handleEnabledChange = useCallback((id: number, checked: boolean) => {
    setConfigured((prev) => prev.map((e) => (e.id === id ? { ...e, enabled: checked ? undefined : false } : e)))
  }, [])

  // 往来类标记（ADR 23）：同 enabled 走显式保存模型。仅资产/负债侧有意义——往来账报表只聚合
  // 这两侧，误标在收支账户上会得到永远空的行，故列渲染也据此禁用。
  const handleCounterpartyChange = useCallback((id: number, checked: boolean) => {
    setConfigured((prev) => prev.map((e) => (e.id === id ? { ...e, counterparty: checked ? true : undefined } : e)))
  }, [])

  // ---- 批次 I：期初余额 ----
  const openObModal = useCallback((record: AccountEntry) => {
    setObRecord(record)
    setObAmount('')
    setObCurrency(operatingCurrencies[0] ?? '')
    setObDate(dayjs())
  }, [operatingCurrencies])

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

  // 直接收 record（不再按 id 回查 configured）：既免掉对 configured 的依赖从而稳定引用，
  // 也避免新增行 id=0 重复时 filter(id) 一次删掉多行
  const handleDelete = useCallback(async (record: AccountEntry) => {
    const ledger = await window.beanwise.listLedgerAccounts()
    if (ledger.accounts.includes(record.value)) {
      message.error('该账户已有记账记录，不可删除')
      return
    }
    setConfigured((prev) => prev.filter((e) => e !== record))
  }, [])

  const handleSave = async () => {
    const empty = configured.find((e) => !e.name.trim())
    if (empty) { message.error('账户名称不能为空'); return }
    setSaving(true)
    const ok = await saveAccountConfig(configured.map((e) => ({ ...e, description: e.description ?? '' })))
    setSaving(false)
    if (ok) message.success('账户配置已保存')
  }

  // 各 tab 一份数据（引用稳定），不再让六个 pane 共用同一份全量 filtered
  const byTab = useTabData(configured)

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
              <AccountsTable
                data={byTab[t.key]}
                usedValues={usedValues}
                onNameChange={handleNameChange}
                onDescriptionChange={handleDescriptionChange}
                onEnabledChange={handleEnabledChange}
                onCounterpartyChange={handleCounterpartyChange}
                onDelete={handleDelete}
                onOpeningBalance={openObModal}
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
