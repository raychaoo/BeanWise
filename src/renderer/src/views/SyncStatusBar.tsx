import { CloudDownloadOutlined, CloudOutlined, ReloadOutlined } from '@ant-design/icons'
import { Badge, Button, Space, Tag, Tooltip } from 'antd'
import { useSyncStore } from '../stores/sync'

interface Props {
  /** 冲突待处理 → 点击进合并视图 */
  onOpenConflict: () => void
  /** 点击「配置同步」开设置 Modal */
  onOpenSettings: () => void
}

/**
 * M6：Header 同步状态条。未配置 → 配置按钮；已配置 → 分支 + 上次同步 +
 * 「拉取」按钮（手动 pull）+ syncing spinner / 失败红 Tag（点击重试 push）/
 * 冲突橙 Tag（点击进合并视图）。
 */
export default function SyncStatusBar({ onOpenConflict, onOpenSettings }: Props) {
  const status = useSyncStore((s) => s.status)
  const conflict = useSyncStore((s) => s.conflict)
  const syncing = useSyncStore((s) => s.syncing)
  const push = useSyncStore((s) => s.push)
  const pull = useSyncStore((s) => s.pull)

  if (!status?.configured) {
    return (
      <Button icon={<CloudOutlined />} onClick={onOpenSettings}>配置同步</Button>
    )
  }
  const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : '从未'
  return (
    <Space>
      {conflict ? (
        <Badge count={1} size="small">
          <Tag color="orange" style={{ cursor: 'pointer' }} onClick={onOpenConflict}>
            冲突待处理
          </Tag>
        </Badge>
      ) : null}
      {status.lastError ? (
        <Tag color="error" style={{ cursor: 'pointer' }} onClick={() => void push()}>
          <ReloadOutlined /> 同步失败，点击重试
        </Tag>
      ) : null}
      <Tag>{status.branch ?? 'main'}</Tag>
      <Tag icon={syncing ? <ReloadOutlined spin /> : undefined}>
        {syncing ? '同步中…' : `上次同步 ${lastSync}`}
      </Tag>
      <Tooltip title="拉取远端更新（手动）">
        <Button size="small" icon={<CloudDownloadOutlined />} loading={syncing} onClick={() => void pull()}>
          拉取
        </Button>
      </Tooltip>
    </Space>
  )
}
