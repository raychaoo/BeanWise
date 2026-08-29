/**
 * 录入页头操作条（批次 B Task 4）：Excel 导入 / AI 录入两个次要入口抽屉化，录入首屏回归凭证表单。
 * 面板组件原样内嵌 Drawer（仅换容器，逻辑零改动）；AI 按钮仅已配置 Key 时渲染（同 AiEntryPanel
 * 的未配置隐藏语义）；草稿填入表单后自动关 AI 抽屉（message 成功由 handleFillForm 发出）。
 */
import { FileExcelOutlined, RobotOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Drawer, Space } from 'antd'
import { useState } from 'react'
import type { AddEntryParams } from '../../../../shared/ipc'
import { useAiStore } from '../../stores/ai'
import AiEntryPanel from '../AiEntryPanel'
import ExcelImportPanel from '../ExcelImportPanel'

interface Props {
  onFillForm: (draft: AddEntryParams) => void
  /** Excel 导入完成后刷新账户库（沿用原面板 onImported 语义） */
  onImported: () => void
  onOpenAccountSettings: () => void
}

export default function EntryActionsBar({ onFillForm, onImported, onOpenAccountSettings }: Props) {
  const configured = useAiStore((s) => s.status?.configured ?? false)
  const [excelOpen, setExcelOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  /** 草稿填入表单 → 自动关抽屉（写路径不变：确认仍走 ProForm「写入账本」提交） */
  const handleFillAndClose = (draft: AddEntryParams) => {
    onFillForm(draft)
    setAiOpen(false)
  }

  return (
    <Space size={8}>
      <Button size="small" icon={<FileExcelOutlined />} onClick={() => setExcelOpen(true)}>
        Excel 导入
      </Button>
      {configured && (
        <Button size="small" icon={<RobotOutlined />} onClick={() => setAiOpen(true)}>
          AI 录入
        </Button>
      )}
      <Button size="small" icon={<SettingOutlined />} onClick={onOpenAccountSettings}>
        账户设置
      </Button>
      <Drawer
        title="Excel 导入"
        width={720}
        open={excelOpen}
        onClose={() => setExcelOpen(false)}
        destroyOnHidden
      >
        <ExcelImportPanel onImported={onImported} />
      </Drawer>
      <Drawer
        title="AI 辅助录入"
        width={560}
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        destroyOnHidden
      >
        <AiEntryPanel onFillForm={handleFillAndClose} />
      </Drawer>
    </Space>
  )
}
