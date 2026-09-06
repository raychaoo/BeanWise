import { BulbFilled, BulbOutlined, CloudDownloadOutlined, CloudOutlined, ReloadOutlined, SettingOutlined, SkinOutlined } from '@ant-design/icons'
import { Badge, Button, Dropdown, Popover, Space, Tag } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAiStore } from '../../stores/ai'
import { useLedgerStore } from '../../stores/ledger'
import { useSyncStore } from '../../stores/sync'
import { useUpdateStore } from '../../stores/update'
import { useThemeContext } from '../../theme/ThemeProvider'
import { usePalette } from '../../theme/useSemanticColors'
import { THEME_LIST, THEMES, type ThemeId } from '../../theme/tokens'

const INDEX_STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

interface Props {
  onOpenSync(): void
  onOpenAi(): void
  onOpenUpdate(): void
}

/**
 * Header 右侧状态区（方案模块 1：Header 8 元素收敛）。
 * 常驻可见：同步分支 Tag（Popover 触发，冲突角标）/ 拉取（或未配置时「配置同步」）/ 更新（Badge dot）/ AI（状态点）。
 * 同步详情与索引状态收进 Popover：上次同步、失败重试、冲突合并入口、同步设置、索引状态 + 重建索引。
 * 注意：「配置同步」「拉取」与分支 Tag 必须常驻可见（e2e sync.spec 不经悬停直接断言）。
 */
export default function HeaderStatusArea({ onOpenSync, onOpenAi, onOpenUpdate }: Props) {
  const navigate = useNavigate()
  const syncStatus = useSyncStore((s) => s.status)
  const conflict = useSyncStore((s) => s.conflict)
  const syncing = useSyncStore((s) => s.syncing)
  const push = useSyncStore((s) => s.push)
  const pull = useSyncStore((s) => s.pull)
  const indexStatus = useLedgerStore((s) => s.status)
  const refreshLedger = useLedgerStore((s) => s.refresh)
  const setLedgerError = useLedgerStore((s) => s.setError)
  const updateState = useUpdateStore((s) => s.state)
  const aiStatus = useAiStore((s) => s.status)
  const [refreshing, setRefreshing] = useState(false)
  const { themeId, mode, toggleMode, setTheme } = useThemeContext()
  const palette = usePalette()

  /** 原 App.tsx Header 索引 Tag 的链路：重建索引 → 重拉状态（与明细视图「重建索引」同链路） */
  const handleRefreshIndex = async () => {
    setRefreshing(true)
    try {
      await window.beanwise.refreshLedgerIndex()
    } catch (err) {
      setLedgerError(String(err))
    }
    await refreshLedger()
    setRefreshing(false)
  }

  const configured = syncStatus?.configured ?? false
  const lastSync = syncStatus?.lastSyncAt ? new Date(syncStatus.lastSyncAt).toLocaleTimeString() : '从未'
  const hasUpdate =
    updateState?.status === 'available' || updateState?.status === 'downloading' || updateState?.status === 'downloaded'

  const popoverContent = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, minWidth: 220 }}>
      <Space size={8} wrap>
        <Tag icon={syncing ? <ReloadOutlined spin /> : undefined}>{syncing ? '同步中…' : `上次同步 ${lastSync}`}</Tag>
        {syncStatus?.lastError ? (
          <Tag color="error" style={{ cursor: 'pointer' }} onClick={() => void push()}>
            <ReloadOutlined /> 同步失败，点击重试
          </Tag>
        ) : null}
      </Space>
      {conflict ? (
        <Button size="small" icon={<CloudOutlined />} onClick={() => navigate('/merge')}>
          冲突待处理 → 合并视图
        </Button>
      ) : null}
      <Space size={8} wrap>
        <Space size={4}>
          索引
          <Tag
            color={INDEX_STATUS_COLOR[indexStatus?.status ?? 'missing']}
            style={{ cursor: refreshing ? 'wait' : 'pointer' }}
            onClick={() => void handleRefreshIndex()}
          >
            {indexStatus?.status ?? 'missing'}
            {refreshing ? '…' : ''}
          </Tag>
        </Space>
        <Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void handleRefreshIndex()}>
          重建索引
        </Button>
      </Space>
      <Button size="small" icon={<SettingOutlined />} onClick={onOpenSync}>
        同步设置
      </Button>
    </div>
  )

  const themeMenuItems = THEME_LIST.map((t) => ({
    key: t.id,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 12, height: 12, borderRadius: 2, background: THEMES[t.id].palette.primary, flex: 'none' }} />
        {t.label}
      </span>
    )
  }))

  return (
    <Space size={4}>
      <Dropdown menu={{ items: themeMenuItems, selectable: true, selectedKeys: [themeId], onClick: ({ key }) => setTheme(key as ThemeId) }}>
        <Button type="text" icon={<SkinOutlined />} aria-label={`主题色：${THEMES[themeId].label}`} title={`主题色：${THEMES[themeId].label}`} />
      </Dropdown>
      <Button
        type="text"
        icon={mode === 'dark' ? <BulbFilled /> : <BulbOutlined />}
        aria-label={mode === 'dark' ? '切换为亮色主题' : '切换为暗色主题'}
        title={mode === 'dark' ? '切换为亮色主题' : '切换为暗色主题'}
        onClick={toggleMode}
      />
      {configured ? (
        <>
          <Badge count={conflict ? 1 : 0} size="small">
            <Popover content={popoverContent} trigger="click" title="同步与索引">
              <Tag icon={<CloudOutlined spin={syncing} />} style={{ cursor: 'pointer' }}>
                {syncStatus?.branch ?? 'main'}
              </Tag>
            </Popover>
          </Badge>
          <Button
            size="small"
            type="text"
            icon={<CloudDownloadOutlined />}
            loading={syncing}
            onClick={() => void pull()}
          >
            拉取
          </Button>
        </>
      ) : (
        <Button type="text" icon={<CloudOutlined />} onClick={onOpenSync}>
          配置同步
        </Button>
      )}
      <Badge dot={hasUpdate}>
        <Button type="text" aria-label="更新" icon={<CloudDownloadOutlined />} onClick={onOpenUpdate} />
      </Badge>
      <Button type="text" onClick={onOpenAi}>
        <Badge status={aiStatus?.configured ? 'success' : 'default'} text="AI 设置" />
      </Button>
    </Space>
  )
}
