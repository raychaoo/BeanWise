/**
 * Excel 导入抽屉（重设计）：仅把 ExcelImportPanel 从 button+Drawer 收回进 header「更多」菜单。
 * 面板逻辑零改动——换容器为 Drawer，open/onClose 由父级控制。
 */
import { Drawer } from 'antd'
import ExcelImportPanel from '../excel-import/ExcelImportPanel'

interface Props {
  open: boolean
  onClose: () => void
  onImported: () => void
}

export default function ExcelImportDrawer({ open, onClose, onImported }: Props) {
  return (
    <Drawer title="Excel 导入" width={720} open={open} onClose={onClose} destroyOnHidden>
      <ExcelImportPanel onImported={onImported} />
    </Drawer>
  )
}
