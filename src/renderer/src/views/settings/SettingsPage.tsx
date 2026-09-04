/**
 * 设置聚合页（批次 D Task 6，方案「设置页」节）：五分组 Card —— ① 账本管理（recents 列表 +
 * switchWorkspace 切换 + 「清空账本」危险操作自明细页迁入，Modal.confirm 原逻辑搬移）
 * ② 同步 ③ AI 助手 ④ 索引状态（自明细页迁入，Descriptions 原样）⑤ 关于与更新。
 * SyncSettingsModal / AiSettingsModal / UpdateModal 保留为 Modal，本页放触发卡片。
 * 批次 H：账本管理卡每项加操作 Dropdown —— 打开/重命名/归档/删除（rename/archive/delete 三 IPC）。
 */
import { CheckOutlined, DeleteOutlined, EditOutlined, InboxOutlined, MoreOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Card, Descriptions, Dropdown, Input, List, message, Modal, Space, Tag, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useState } from 'react'
import { useAiStore } from '../../stores/ai'
import { useLedgerStore } from '../../stores/ledger'
import { useSyncStore } from '../../stores/sync'
import { useUpdateStore } from '../../stores/update'
import { basenamePath } from '../../utils/path'
import { formatAmount } from '../../utils/format'
import { switchWorkspace } from '../workspace/LedgerSwitcher'
import AiSettingsModal from './AiSettingsModal'
import SyncSettingsModal from './SyncSettingsModal'
import UpdateModal from './UpdateModal'

const STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

/** 与主进程 workspace:rename 校验一致（双端同规，主进程仍二次校验） */
const RENAME_PATTERN = /^[\w\u4e00-\u9fa5-]{1,100}$/

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
  // 批次 H：账本管理操作态
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleteInput, setDeleteInput] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)

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

  /** 批次 H：重命名（主进程白名单 + 同名校验；成功后整页 reload —— current 运行时已重建，非 current 列表随重挂刷新） */
  const openRename = (path: string) => {
    setRenameValue(basenamePath(path))
    setRenameTarget(path)
  }

  const handleRenameOk = async () => {
    if (!renameTarget || renameBusy) return
    const name = renameValue.trim()
    if (!RENAME_PATTERN.test(name)) {
      message.error('名称仅允许中文、字母、数字、下划线与连字符（1-100 字符）')
      return
    }
    setRenameBusy(true)
    try {
      const result = await window.beanwise.renameWorkspace(renameTarget, name)
      if (result.ok) {
        setRenameTarget(null)
        window.location.reload()
      } else {
        message.error(result.message ?? '重命名失败')
      }
    } catch (err) {
      message.error(String(err))
    } finally {
      setRenameBusy(false)
    }
  }

  /** 批次 H：归档（仅非 current 可触发；移动到 <父目录>/.beanwise-archive/ 下，成功后整页 reload 刷新列表） */
  const confirmArchive = (path: string) => {
    Modal.confirm({
      title: '归档账本',
      content: `「${basenamePath(path)}」将移动到该账本同级目录的 .beanwise-archive 文件夹下（原目录名 + 时间戳），可随时从该目录找回。`,
      okText: '归档',
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await window.beanwise.archiveWorkspace(path)
          if (result.ok) {
            window.location.reload()
          } else {
            message.error(result.message ?? '归档失败')
          }
        } catch (err) {
          message.error(String(err))
        }
      }
    })
  }

  /** 批次 H：删除（仅非 current；输入目录名完全一致才启用确定，成功后本地重拉列表与状态） */
  const openDelete = (path: string) => {
    setDeleteInput('')
    setDeleteTarget(path)
  }

  const handleDeleteOk = async () => {
    if (!deleteTarget || deleteBusy) return
    setDeleteBusy(true)
    try {
      const result = await window.beanwise.deleteWorkspace(deleteTarget)
      if (result.ok) {
        setDeleteTarget(null)
        const [ws, latest] = await Promise.all([
          window.beanwise.getWorkspaceStatus(),
          window.beanwise.getWorkspaceRecents()
        ])
        setWorkspace(ws.current)
        setRecents(latest)
        message.success('账本已删除')
      } else {
        message.error(result.message ?? '删除失败')
      }
    } catch (err) {
      message.error(String(err))
    } finally {
      setDeleteBusy(false)
    }
  }

  /** 每项操作菜单：打开（current disabled ✓）/ 重命名 / 归档（current 禁用）/ 删除（仅非 current 显示） */
  const buildLedgerMenu = (path: string, isCurrent: boolean): MenuProps['items'] => [
    {
      key: 'open',
      icon: isCurrent ? <CheckOutlined /> : undefined,
      label: '打开',
      disabled: isCurrent,
      onClick: () => void switchWorkspace(path)
    },
    { type: 'divider' },
    isCurrent
      ? {
          key: 'rename',
          icon: <EditOutlined />,
          label: <Tooltip title="当前账本正在使用中，无法重命名；请先切换到其他账本"><span>重命名</span></Tooltip>,
          disabled: true
        }
      : { key: 'rename', icon: <EditOutlined />, label: '重命名', onClick: () => openRename(path) },
    isCurrent
      ? {
          key: 'archive',
          icon: <InboxOutlined />,
          label: <Tooltip title="当前账本不可归档，请先切换到其他账本"><span>归档</span></Tooltip>,
          disabled: true
        }
      : { key: 'archive', icon: <InboxOutlined />, label: '归档', onClick: () => confirmArchive(path) },
    ...(isCurrent
      ? []
      : [{ key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true, onClick: () => openDelete(path) }])
  ]

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
                actions={[
                  ...(isCurrent
                    ? [<Tag key="current" icon={<CheckOutlined />} color="success">当前</Tag>]
                    : [<Button key="open" size="small" onClick={() => void switchWorkspace(p)}>打开</Button>]),
                  <Dropdown key="menu" menu={{ items: buildLedgerMenu(p, isCurrent) }} trigger={['click']}>
                    <Button size="small" type="text" icon={<MoreOutlined />} aria-label={`账本操作：${basenamePath(p)}`} />
                  </Dropdown>
                ]}
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

      {/* 批次 H：重命名账本（默认填当前目录名；主进程二次校验同规则白名单） */}
      <Modal
        title="重命名账本"
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        okText="重命名"
        cancelText="取消"
        confirmLoading={renameBusy}
        onOk={() => void handleRenameOk()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text>
            修改目录名（同目录下不可重名）：
            <Typography.Text code>{renameTarget ?? ''}</Typography.Text>
          </Typography.Text>
          <Input
            value={renameValue}
            maxLength={100}
            placeholder="新名称（中文/字母/数字/下划线/连字符）"
            onPressEnter={() => void handleRenameOk()}
            onChange={(e) => setRenameValue(e.target.value)}
          />
        </Space>
      </Modal>

      {/* 批次 H：删除账本（仅非 current；输入目录名完全一致才启用确定——危险操作二级确认） */}
      <Modal
        title="删除账本"
        open={deleteTarget !== null}
        onCancel={() => setDeleteTarget(null)}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: deleteTarget === null || deleteInput !== basenamePath(deleteTarget) }}
        confirmLoading={deleteBusy}
        onOk={() => void handleDeleteOk()}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text>
            将永久删除目录
            <Typography.Text code>{deleteTarget ?? ''}</Typography.Text>
            （含账本文件、索引与配置），此操作不可恢复。请输入目录名
            <Typography.Text strong>{deleteTarget ? basenamePath(deleteTarget) : ''}</Typography.Text>
            以确认：
          </Typography.Text>
          <Input value={deleteInput} placeholder={deleteTarget ? basenamePath(deleteTarget) : ''} onChange={(e) => setDeleteInput(e.target.value)} />
        </Space>
      </Modal>
    </Space>
  )
}
