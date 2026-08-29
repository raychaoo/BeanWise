import { CheckOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { Button, Dropdown, message } from 'antd'
import type { MenuProps } from 'antd'
import { useState } from 'react'

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

    const result = await window.beanwise.openWorkspace(picked.path)
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
 * 账本（工作目录）切换器 · 基础版（批次 A；批次 C 增强 recents / Ctrl+K / 路径 util）。
 * Header 左侧主入口：当前账本 basename + Dropdown（当前项 disabled + 浏览其他目录…）。
 */
export default function LedgerSwitcher({ current }: { current: string }) {
  const [switching, setSwitching] = useState(false)
  // 临时内联 basename（批次 C 抽 utils/path.ts）
  const basename = current.split(/[\\/]/).pop() ?? current

  const items: MenuProps['items'] = [
    { key: 'current', icon: <CheckOutlined />, label: basename, disabled: true },
    { type: 'divider' },
    { key: 'browse', icon: <FolderOpenOutlined />, label: '浏览其他目录…' }
  ]

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === 'browse') {
            setSwitching(true)
            void browseAndOpenWorkspace().finally(() => setSwitching(false))
          }
        }
      }}
    >
      {/* 完整路径用原生 title 悬停展示（Dropdown 直接子元素必须持有 ref，不能再包 Tooltip） */}
      <Button type="text" size="large" loading={switching} title={current} icon={<FolderOpenOutlined />}>
        {basename}
      </Button>
    </Dropdown>
  )
}
