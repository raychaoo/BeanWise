/**
 * 应用壳（批次 A）：HashRouter + ProLayout。菜单即路由表单源（key=路径），主内容区唯一滚动容器
 * （.page-scroll）+ 纯 CSS 路由切换动画（layout.less，尊重 prefers-reduced-motion）。
 * 工作目录门控：ready 前框架先行渲染 Skeleton（模块 9，不再白屏 null），失败 → Result 兜底，
 * 未选目录 → 全屏 WorkspaceGate。菜单文本「录入/明细/报表」为 e2e 依赖，不得改名。
 */
import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  CloudOutlined,
  DashboardOutlined,
  FileTextOutlined,
  FormOutlined,
  SettingOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import { Button, Result, Skeleton } from 'antd'
import { ProLayout } from '@ant-design/pro-components'
import type { MenuDataItem } from '@ant-design/pro-components'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HashRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAiStore } from './stores/ai'
import { useLedgerStore } from './stores/ledger'
import { useSyncStore } from './stores/sync'
import { useUpdateStore } from './stores/update'
import AccountsPage from './views/AccountsPage'
import AiSettingsModal from './views/AiSettingsModal'
import ConflictView from './views/ConflictView'
import DashboardPage from './views/DashboardPage'
import EditorView from './views/EditorView'
import EntriesView from './views/EntriesView'
import EntryFormView from './views/EntryFormView'
import HeaderStatusArea from './views/HeaderStatusArea'
import LedgerSwitcher, { browseAndOpenWorkspace } from './views/LedgerSwitcher'
import ReconcilePage from './views/ReconcilePage'
import ReportsView from './views/ReportsView'
import SettingsPage from './views/SettingsPage'
import SyncSettingsModal from './views/SyncSettingsModal'
import UpdateModal from './views/UpdateModal'
import WorkspaceGate from './views/WorkspaceGate'
import type { WorkspaceStatus } from '../../shared/ipc'

interface ShellProps {
  ready: boolean
  workspace: WorkspaceStatus | null
  onOpenSync(): void
  onOpenAi(): void
  onOpenUpdate(): void
}

/** ProLayout 框架：Sider 菜单 + Header（账本切换 + 右侧状态区）+ 主内容区（滚动/动画/复位） */
function Shell({ ready, workspace, onOpenSync, onOpenAi, onOpenUpdate }: ShellProps) {
  const location = useLocation()
  const conflict = useSyncStore((s) => s.conflict)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // 路由切换滚动复位（方案第三节）
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0)
  }, [location.pathname])

  const menu: MenuDataItem[] = useMemo(
    () => [
      { path: '/', name: '总览', icon: <DashboardOutlined /> },
      { path: '/entry', name: '录入', icon: <FormOutlined /> },
      { path: '/entries', name: '明细', icon: <UnorderedListOutlined /> },
      { path: '/reconcile', name: '对账', icon: <AuditOutlined /> },
      { path: '/accounts', name: '账户', icon: <AppstoreOutlined /> },
      { path: '/reports', name: '报表', icon: <BarChartOutlined /> },
      { path: '/editor', name: '编辑器', icon: <FileTextOutlined /> },
      ...(conflict ? [{ path: '/merge', name: '合并', icon: <CloudOutlined /> }] : [])
    ],
    [conflict]
  )

  return (
    <ProLayout
      title="BeanWise"
      logo={false} // 默认 logo 为 remote 图源，CSP 禁 remote；本地 logo 资产留后续批次
      layout="mix" // side 布局桌面端不渲染顶部 Header（pro-layout 硬编码），mix = 顶栏(账本切换+状态区) + 侧边菜单
      pageTitleRender={false} // 禁止 ProLayout 改写 document.title（保持 index.html 的 BeanWise，e2e 依赖）
      route={{ path: '/', routes: menu }}
      location={{ pathname: location.pathname }}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      headerContentRender={() =>
        ready && workspace?.current ? <LedgerSwitcher current={workspace.current} /> : null
      }
      actionsRender={() =>
        ready ? [<HeaderStatusArea key="status" onOpenSync={onOpenSync} onOpenAi={onOpenAi} onOpenUpdate={onOpenUpdate} />] : []
      }
      avatarProps={
        ready
          ? { icon: <SettingOutlined />, render: (_, dom) => <Link to="/settings">{dom}</Link> }
          : undefined
      }
      contentStyle={{ padding: 0 }}
    >
      <div ref={contentRef} className="page-scroll">
        <div key={location.pathname} className="page-enter">
          {ready ? (
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/entry" element={<EntryFormView />} />
              <Route path="/entries" element={<EntriesView />} />
              <Route path="/reconcile" element={<ReconcilePage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/reports" element={<ReportsView />} />
              <Route path="/editor" element={<EditorView />} />
              <Route path="/merge" element={<ConflictView />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          ) : (
            <Skeleton active paragraph={{ rows: 8 }} />
          )}
        </div>
      </div>
    </ProLayout>
  )
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)

  const loadWorkspace = useCallback(async () => {
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
  }, [])

  useEffect(() => {
    void loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    void useUpdateStore.getState().init()
  }, [])

  /** 工作目录就绪后加载各域状态（WorkspaceGate 回调） */
  const handleWorkspaceOpened = (ws: WorkspaceStatus) => {
    setWorkspace(ws)
    setReady(true)
    void useLedgerStore.getState().refresh()
    void useLedgerStore.getState().loadAccounts()
    void useSyncStore.getState().loadStatus()
    void useAiStore.getState().loadStatus()
  }

  if (workspaceError) {
    return (
      <Result
        status="error"
        title="读取工作目录状态失败"
        subTitle={workspaceError}
        extra={[
          <Button
            key="retry"
            type="primary"
            onClick={() => {
              setWorkspaceError(null)
              setReady(false)
              void loadWorkspace()
            }}
          >
            重试
          </Button>,
          <Button key="browse" onClick={() => void browseAndOpenWorkspace()}>
            更换目录
          </Button>
        ]}
      />
    )
  }

  // ready 前框架先行（Skeleton 占位，不再白屏）
  if (!ready || !workspace) {
    return (
      <HashRouter>
        <Shell ready={false} workspace={null} onOpenSync={() => setSyncOpen(true)} onOpenAi={() => setAiOpen(true)} onOpenUpdate={() => setUpdateOpen(true)} />
      </HashRouter>
    )
  }

  // 未选择工作目录 → 全屏门控
  if (!workspace.current) return <WorkspaceGate onOpened={handleWorkspaceOpened} />

  return (
    <HashRouter>
      <Shell
        ready
        workspace={workspace}
        onOpenSync={() => setSyncOpen(true)}
        onOpenAi={() => setAiOpen(true)}
        onOpenUpdate={() => setUpdateOpen(true)}
      />
      <SyncSettingsModal open={syncOpen} onClose={() => setSyncOpen(false)} />
      <AiSettingsModal open={aiOpen} onClose={() => setAiOpen(false)} />
      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </HashRouter>
  )
}
