/**
 * 应用壳（M4）：Sider 导航（录入 / 明细，为 M5-M8 预留扩展位）+ Header（标题 + 索引状态 Tag）。
 * M3 只读验收面板（#ledger-status / #ledger-entries）已下线，由正式视图取代。
 */
import { FormOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { Layout, Menu, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useLedgerStore } from './stores/ledger'
import EntriesView from './views/EntriesView'

const { Sider, Header, Content } = Layout

const STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

/** 录入视图占位（M4-T5 接入 ProForm） */
function EntryPlaceholder() {
  return (
    <div style={{ paddingTop: 80, textAlign: 'center', color: '#999' }}>
      录入视图（Task 5 接入 ProForm）
    </div>
  )
}

export default function App() {
  const [view, setView] = useState<'entry' | 'entries'>('entry')
  const status = useLedgerStore((s) => s.status)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void useLedgerStore.getState().refresh()
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
          onClick={({ key }) => setView(key as 'entry' | 'entries')}
          items={[
            { key: 'entry', icon: <FormOutlined />, label: '录入' },
            { key: 'entries', icon: <UnorderedListOutlined />, label: '明细' }
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
          <Tag
            color={STATUS_COLOR[status?.status ?? 'missing']}
            style={{ cursor: refreshing ? 'wait' : 'pointer' }}
            onClick={() => void handleRefreshIndex()}
          >
            索引：{status?.status ?? 'missing'}
            {refreshing ? '…' : ''}
          </Tag>
        </Header>
        <Content style={{ padding: 24 }}>{view === 'entry' ? <EntryPlaceholder /> : <EntriesView />}</Content>
      </Layout>
    </Layout>
  )
}
