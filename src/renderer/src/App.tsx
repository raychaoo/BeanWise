/**
 * 应用壳（M4）：Sider 导航（录入 / 明细，为 M5-M8 预留扩展位）+ Header（标题 + 索引状态 Tag）。
 * M3 只读验收面板（#ledger-status / #ledger-entries）已下线，由正式视图取代。
 */
import { BarChartOutlined, CloudDownloadOutlined, CloudOutlined, FileTextOutlined, FormOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { Button, Layout, Menu, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useAiStore } from './stores/ai'
import { useLedgerStore } from './stores/ledger'
import { useSyncStore } from './stores/sync'
import { useUpdateStore } from './stores/update'
import AiSettingsModal from './views/AiSettingsModal'
import ConflictView from './views/ConflictView'
import EditorView from './views/EditorView'
import EntriesView from './views/EntriesView'
import EntryFormView from './views/EntryFormView'
import ReportsView from './views/ReportsView'
import SyncSettingsModal from './views/SyncSettingsModal'
import SyncStatusBar from './views/SyncStatusBar'
import UpdateModal from './views/UpdateModal'
import WorkspaceGate from './views/WorkspaceGate'
import WorkspaceSwitcher from './views/WorkspaceSwitcher'

const { Sider, Header, Content } = Layout

const STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

export default function App() {
  const [view, setView] = useState<'entry' | 'entries' | 'editor' | 'conflict' | 'reports'>('entry')
  const status = useLedgerStore((s) => s.status)
  const conflict = useSyncStore((s) => s.conflict)
  const [refreshing, setRefreshing] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [workspace, setWorkspace] = useState<{ current: string | null } | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const aiStatus = useAiStore((s) => s.status)

  useEffect(() => {
    void (async () => {
      try {
        const ws = await window.beanwise.getWorkspaceStatus()
        setWorkspace(ws)
        setReady(true)
        if (ws?.current) {
          void useLedgerStore.getState().refresh()
          void useLedgerStore.getState().loadAccounts()
          void useSyncStore.getState().loadStatus()
          void useAiStore.getState().loadStatus()
        }
      } catch {
        setWorkspaceError('读取工作目录状态失败')
        setReady(true)
      }
    })()
  }, [])

  useEffect(() => {
    void useUpdateStore.getState().init()
  }, [])

  /** 工作目录就绪后加载各域状态（WorkspaceGate 回调） */
  const handleWorkspaceOpened = () => {
    setReady(false) // 先隐藏 gate 再重新检测，避免闪烁
    void (async () => {
      try {
        const ws = await window.beanwise.getWorkspaceStatus()
        setWorkspace(ws)
        setReady(true)
        if (ws?.current) {
          void useLedgerStore.getState().refresh()
          void useLedgerStore.getState().loadAccounts()
          void useSyncStore.getState().loadStatus()
          void useAiStore.getState().loadStatus()
        }
      } catch {
        setWorkspaceError('读取工作目录状态失败')
        setReady(true)
      }
    })()
  }

  if (workspaceError) return <div style={{ padding: 40, color: 'red' }}>{workspaceError}</div>

  // 等待 workspace 状态加载完成再渲染
  if (!ready || !workspace) return null

  // 未选择工作目录 → 全屏门控
  if (!workspace.current) return <WorkspaceGate onOpened={handleWorkspaceOpened} />

  /** Header Tag 点击：重建索引 → 重拉状态（与明细视图「重建索引」同链路） */
  const handleRefreshIndex = async () => {
    setRefreshing(true)
    try {
      await window.beanwise.refreshLedgerIndex()
    } catch (err) {
      useLedgerStore.getState().setError(String(err))
    }
    await useLedgerStore.getState().refresh()
    setRefreshing(false)
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={200} theme="light">
        <div className="app-logo">BeanWise</div>
        <div title={workspace.current} style={{ padding: '0 16px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{workspace.current}</Typography.Text>
        </div>
        <div style={{ padding: '0 12px 8px' }}>
          <WorkspaceSwitcher />
        </div>
        <Menu
          mode="inline"
          selectedKeys={[view]}
          onClick={({ key }) => setView(key as 'entry' | 'entries' | 'editor' | 'conflict' | 'reports')}
          items={[
            { key: 'entry', icon: <FormOutlined />, label: '录入' },
            { key: 'entries', icon: <UnorderedListOutlined />, label: '明细' },
            { key: 'reports', icon: <BarChartOutlined />, label: '报表' },
            { key: 'editor', icon: <FileTextOutlined />, label: '编辑器' },
            ...(conflict
              ? [{ key: 'conflict' as const, icon: <CloudOutlined />, label: '合并' }]
              : [])
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0'
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            {window.beanwise.appName}
          </Typography.Title>
          <Space style={{ marginRight: 12 }}>
            <Tag color={aiStatus?.configured ? 'success' : 'default'}>
              AI：{aiStatus?.configured ? '已配置' : '未配置'}
            </Tag>
            <Button onClick={() => setAiOpen(true)}>AI 设置</Button>
            <Button icon={<CloudDownloadOutlined />} onClick={() => setUpdateOpen(true)}>更新</Button>
          </Space>
          <div className="sync-status-bar">
            <Tag
              color={STATUS_COLOR[status?.status ?? 'missing']}
              style={{ cursor: refreshing ? 'wait' : 'pointer' }}
              onClick={() => void handleRefreshIndex()}
            >
              索引：{status?.status ?? 'missing'}
              {refreshing ? '…' : ''}
            </Tag>
            <SyncStatusBar onOpenConflict={() => setView('conflict')} onOpenSettings={() => setSyncOpen(true)} />
          </div>
        </Header>
        <Content style={{ padding: 24 }}>
          <div style={{ display: view === 'entry' ? 'block' : 'none' }}>
            <EntryFormView />
          </div>
          <div style={{ display: view === 'entries' ? 'block' : 'none' }}><EntriesView /></div>
          <div style={{ display: view === 'editor' ? 'block' : 'none', height: 'calc(100vh - 112px)' }}>
            <EditorView />
          </div>
          {view === 'reports' && <ReportsView />}
          <div style={{ display: view === 'conflict' ? 'block' : 'none', height: 'calc(100vh - 112px)' }}>
            <ConflictView />
          </div>
        </Content>
      </Layout>
      <SyncSettingsModal open={syncOpen} onClose={() => setSyncOpen(false)} />
      <AiSettingsModal open={aiOpen} onClose={() => setAiOpen(false)} />
      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </Layout>
  )
}
