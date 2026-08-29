/**
 * 设置聚合页（批次 D Task 6，方案「设置页」节）：五分组 Card —— ① 账本管理（recents 列表 +
 * switchWorkspace 切换 + 「清空账本」危险操作自明细页迁入，Modal.confirm 原逻辑搬移）
 * ② 同步 ③ AI 助手 ④ 索引状态（自明细页迁入，Descriptions 原样）⑤ 关于与更新。
 * SyncSettingsModal / AiSettingsModal / UpdateModal 保留为 Modal，本页放触发卡片。
 */
import { CheckOutlined, DeleteOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Card, Descriptions, List, message, Modal, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useAiStore } from '../stores/ai'
import { useLedgerStore } from '../stores/ledger'
import { useSyncStore } from '../stores/sync'
import { useUpdateStore } from '../stores/update'
import { basenamePath } from '../utils/path'
import { formatAmount } from '../utils/format'
import { switchWorkspace } from './LedgerSwitcher'
import AiSettingsModal from './AiSettingsModal'
import SyncSettingsModal from './SyncSettingsModal'
import UpdateModal from './UpdateModal'

const STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

/** 数值展示（条目数/错误数）：走 formatAmount 统一千分位，空值 '—'（自 EntriesView 原样迁入） */
function formatCount(n: number | undefined): string {
  return formatAmount(n === undefined ? null : String(n))
}

export default function SettingsPage() {
  const status = useLedgerStore((s) => s.status)
  const refresh = useLedgerStore((s) => s.refresh)
  const syncStatus = useSyncStore((s) => s.status)
  const aiStatus = useAiStore((s) => s.status)
  const updateState = useUpdateStore((s) => s.state)

  const [workspace, setWorkspace] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>([])
  const [clearing, setClearing] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)

  useEffect(() => {
    void window.beanwise
      .getWorkspaceStatus()
      .then((ws) => setWorkspace(ws.current))
      .catch(() => setWorkspace(null))
    void window.beanwise
      .getWorkspaceRecents()
      .then(setRecents)
      .catch(() => setRecents([]))
  }, [])

  /** 自 EntriesView 迁入（Modal.confirm 原逻辑；其本地分页复位 setPage(1) 不随迁——设置页无分页态） */
  const handleClear = () => {
    Modal.confirm({
      title: '清空账本',
      content: '将删除账本中的所有交易记录与账户 open 记录，账户设置会保留。此操作不可撤销。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setClearing(true)
        try {
          const result = typeof window.beanwise.clearLedger === 'function'
            ? await window.beanwise.clearLedger()
            : await clearViaSaveFile()
          if (result.ok) {
            message.success('账本已清空')
            await refresh()
            await useLedgerStore.getState().loadAccounts()
          } else {
            message.error(result.message ?? '清空失败')
          }
        } catch (err) {
          message.error(String(err))
        } finally {
          setClearing(false)
        }
      }
    })
  }

  /** 旧版 preload 没有 clearLedger 时，复用读取 + 整文件覆盖保存清空账本（自 EntriesView 原样迁入）。 */
  const clearViaSaveFile = async () => {
    const read = await window.beanwise.readLedgerFile()
    if (!read.ok || !read.fingerprint) throw new Error(read.message ?? '读取账本失败')
    return window.beanwise.saveLedgerFile({ content: '', expectedFingerprint: read.fingerprint })
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="账本管理"
        extra={
          <Button danger icon={<DeleteOutlined />} loading={clearing} onClick={handleClear}>
            清空账本
          </Button>
        }
      >
        <List
          size="small"
          dataSource={recents}
          locale={recents.length === 0 ? { emptyText: '暂无最近账本记录' } : undefined}
          renderItem={(p) => {
            const isCurrent = p === workspace
            return (
              <List.Item
                actions={
                  isCurrent
                    ? [<Tag key="current" icon={<CheckOutlined />} color="success">当前</Tag>]
                    : [<Button key="open" size="small" onClick={() => void switchWorkspace(p)}>打开</Button>]
                }
              >
                <Typography.Text title={p}>{basenamePath(p)}</Typography.Text>
              </List.Item>
            )
          }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          每个目录独立账本与索引，切换后整页重载
        </Typography.Text>
      </Card>

      <Card title="同步">
        <Space size={16} wrap>
          {syncStatus?.configured ? (
            <Typography.Text>
              {syncStatus.repoUrl} · {syncStatus.branch} · 上次同步：
              {syncStatus.lastSyncAt ? new Date(syncStatus.lastSyncAt).toLocaleString() : '从未'}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">未配置 GitHub 同步</Typography.Text>
          )}
          <Button icon={<SettingOutlined />} onClick={() => setSyncOpen(true)}>同步设置</Button>
        </Space>
      </Card>

      <Card title="AI 助手">
        <Space size={16} wrap>
          {aiStatus?.configured ? (
            <Typography.Text>已配置 · {aiStatus.model}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">未配置 API Key（录入页 AI 入口隐藏）</Typography.Text>
          )}
          <Button icon={<SettingOutlined />} onClick={() => setAiOpen(true)}>AI 设置</Button>
        </Space>
      </Card>

      <Card title="索引状态">
        <Descriptions column={2} size="small">
          <Descriptions.Item label="路径">{status?.path ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={STATUS_COLOR[status?.status ?? 'missing']}>{status?.status ?? 'missing'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="条目数"><span className="num">{formatCount(status?.entryCount)}</span></Descriptions.Item>
          <Descriptions.Item label="错误数"><span className="num">{formatCount(status?.errorCount)}</span></Descriptions.Item>
          <Descriptions.Item label="更新时间" span={2}>
            {status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—'}
          </Descriptions.Item>
          {status?.lastError && (
            <Descriptions.Item label="最近错误" span={2}>
              <span className="error-text">{status.lastError}</span>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Card title="关于与更新">
        <Space size={16} wrap>
          <Typography.Text>当前版本：v{updateState?.currentVersion || '—'}</Typography.Text>
          <Button onClick={() => setUpdateOpen(true)}>检查更新</Button>
        </Space>
      </Card>

      <SyncSettingsModal open={syncOpen} onClose={() => setSyncOpen(false)} />
      <AiSettingsModal open={aiOpen} onClose={() => setAiOpen(false)} />
      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </Space>
  )
}
