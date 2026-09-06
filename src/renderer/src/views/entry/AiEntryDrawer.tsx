/**
 * AI 辅助录入抽屉（重设计）：仅把 AiEntryPanel 从 button+Drawer 收回进 header「更多」菜单。
 * 面板逻辑零改动——换容器为 Drawer，open/onClose 由父级控制；草稿填入表单后自动关抽屉。
 */
import { Drawer } from 'antd'
import type { AddEntryParams } from '../../../../shared/ipc'
import AiEntryPanel from '../ai-entry/AiEntryPanel'

interface Props {
  open: boolean
  onClose: () => void
  onFillForm: (draft: AddEntryParams) => void
}

export default function AiEntryDrawer({ open, onClose, onFillForm }: Props) {
  return (
    <Drawer title="AI 辅助录入" width={560} open={open} onClose={onClose} destroyOnHidden>
      <AiEntryPanel onFillForm={onFillForm} />
    </Drawer>
  )
}
