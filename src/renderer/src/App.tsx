/**
 * 应用壳（M4）：Sider 导航（录入 / 明细，为 M5-M8 预留扩展位）+ Header（标题 + 索引状态 Tag）。
 * M3 只读验收面板（#ledger-status / #ledger-entries）已下线，由正式视图取代。
 */
import { CloudOutlined, FileTextOutlined, FormOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { Button, Layout, Menu, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useAiStore } from './stores/ai'
import { useLedgerStore } from './stores/ledger'
import { useSyncStore } from './stores/sync'
import AiSettingsModal from './views/AiSettingsModal'
import ConflictView from './views/ConflictView'
import EditorView from './views/EditorView'
import EntriesView from './views/EntriesView'
import EntryFormView from './views/EntryFormView'
import SyncSettingsModal from './views/SyncSettingsModal'
import SyncStatusBar from './views/SyncStatusBar'

const { Sider, Header, Content } = Layout

const STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

export default function App() {
  const [view, setView] = useState<'entry' | 'entries' | 'editor' | 'conflict'>('entry')
  const status = useLedgerStore((s) => s.status)
  const conflict = useSyncStore((s) => s.conflict)
  const [refreshing, setRefreshing] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const aiStatus = useAiStore((s) => s.status)

  useEffect(() => {
    void useLedgerStore.getState().refresh()
    void useSyncStore.getState().loadStatus()
    void useAiStore.getState().loadStatus()
  }, [])

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
        <Menu
          mode="inline"
          selectedKeys={[view]}
          onClick={({ key }) => setView(key as 'entry' | 'entries' | 'editor' | 'conflict')}
          items={[
            { key: 'entry', icon: <FormOutlined />, label: '录入' },
            { key: 'entries', icon: <UnorderedListOutlined />, label: '明细' },
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
            <EntryFormView onOpenAiSettings={() => setAiOpen(true)} />
          </div>
          <div style={{ display: view === 'entries' ? 'block' : 'none' }}><EntriesView /></div>
          <div style={{ display: view === 'editor' ? 'block' : 'none', height: 'calc(100vh - 112px)' }}>
            <EditorView />
          </div>
          <div style={{ display: view === 'conflict' ? 'block' : 'none', height: 'calc(100vh - 112px)' }}>
            <ConflictView />
          </div>
        </Content>
      </Layout>
      <SyncSettingsModal open={syncOpen} onClose={() => setSyncOpen(false)} />
      <AiSettingsModal open={aiOpen} onClose={() => setAiOpen(false)} />
    </Layout>
  )
}
