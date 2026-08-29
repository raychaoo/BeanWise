import { CheckOutlined, FolderOpenOutlined, SwapOutlined } from '@ant-design/icons'
import { Button, Dropdown, Modal, Tooltip, theme, message } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useState } from 'react'
import { useEntryFormStore } from '../stores/entry-form'
import { basenamePath } from '../utils/path'
import QuickSwitchModal from './QuickSwitchModal'

/**
 * 浏览并打开其他工作目录：choose → open → 整页 reload（CLAUDE.md 约束 9，不新增软切换路径）。
 * 原 WorkspaceSwitcher 链路迁入；App.tsx 失败兜底的「更换目录」复用本函数。
 */
export async function browseAndOpenWorkspace(): Promise<void> {
  try {
    const picked = await window.beanwise.chooseWorkspaceFolder()
    if (!picked.ok) {
      message.error(picked.message ?? '选择文件夹失败')
      return
    }
    if (picked.canceled || !picked.path) return
    await openAndReload(picked.path)
  } catch (err) {
    message.error(String(err))
  }
}

/** open → 成功整页 reload（CLAUDE.md 约束 9）；失败 message.error（切换与浏览链路共用） */
async function openAndReload(path: string): Promise<void> {
  try {
    const result = await window.beanwise.openWorkspace(path)
    if (!result.ok || !result.status) {
      message.error(result.message ?? '打开工作目录失败')
      return
    }
    window.location.reload()
  } catch (err) {
    message.error(String(err))
  }
}

/**
 * 切换到指定工作目录：录入表单 dirty 时先二次确认（只读批次 A 的 useEntryFormStore，写入接线归批次 B），
 * 确认/直接通过后 open + 整页 reload。导出供 QuickSwitchModal（批次 C）与设置页（批次 D）复用。
 */
export async function switchWorkspace(path: string): Promise<void> {
  if (useEntryFormStore.getState().dirty) {
    Modal.confirm({
      title: '切换账本',
      content: '录入表单有未提交内容，切换后将丢失。确定切换？',
      okText: '切换',
      // antd 静态 Modal.confirm 不消费 ConfigProvider locale，取消键默认英文，需显式指定
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => openAndReload(path)
    })
    return
  }
  await openAndReload(path)
}

/**
 * 账本（工作目录）切换器：Header 左侧主入口。
 * Dropdown 结构：当前账本（✓ + 路径 Tooltip，disabled）→ 最近账本（recents，排除当前，路径 Tooltip）
 * → 浏览其他目录… → 底部固定说明（数据隔离提示）。
 */
export default function LedgerSwitcher({ current }: { current: string }) {
  const [switching, setSwitching] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const [quickOpen, setQuickOpen] = useState(false)
  const { token } = theme.useToken()
  const currentBase = basenamePath(current)

  useEffect(() => {
    void window.beanwise
      .getWorkspaceRecents()
      .then(setRecents)
      .catch(() => setRecents([]))
  }, [])

  // Ctrl+K / Cmd+K 快捷切换弹层：本组件常驻 Header，等价全局快捷键（不改 App.tsx）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setQuickOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const recentItems: MenuProps['items'] = recents
    .filter((p) => p !== current)
    .map((p) => ({
      key: p,
      label: (
        <Tooltip title={p} placement="right" mouseEnterDelay={0.4}>
          <span>{basenamePath(p)}</span>
        </Tooltip>
      )
    }))

  const items: MenuProps['items'] = [
    {
      key: current,
      icon: <CheckOutlined />,
      disabled: true,
      label: (
        <Tooltip title={current} placement="right" mouseEnterDelay={0.4}>
          <span>{currentBase}</span>
        </Tooltip>
      )
    },
    ...(recentItems.length > 0 ? [{ type: 'divider' as const }, ...recentItems] : []),
    { type: 'divider' as const },
    { key: 'browse', icon: <FolderOpenOutlined />, label: '浏览其他目录…' },
    { type: 'divider' as const },
    {
      key: '__hint__',
      disabled: true,
      label: (
        <span style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
          每个目录独立账本与索引，切换后整页重载
        </span>
      )
    }
  ]

  return (
    <>
      <Dropdown
        menu={{
          items,
          onClick: ({ key }) => {
            if (key === current) return
            if (key === 'browse') {
              setSwitching(true)
              void browseAndOpenWorkspace().finally(() => setSwitching(false))
              return
            }
            void switchWorkspace(key)
          }
        }}
      >
        {/* 完整路径用原生 title 悬停展示（Dropdown 直接子元素必须持有 ref，不能再包 Tooltip） */}
        <Button type="text" size="large" loading={switching} title={current} icon={<SwapOutlined />}>
          {currentBase}
        </Button>
      </Dropdown>
      <QuickSwitchModal
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        recents={recents.filter((p) => p !== current)}
        onPick={(path) => void switchWorkspace(path)}
      />
    </>
  )
}
