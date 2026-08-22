import { FolderOpenOutlined } from '@ant-design/icons'
import { Button, message } from 'antd'
import { useState } from 'react'

/** 侧边栏目录切换入口。切换成功后整页重载，确保所有域状态不残留上一个账本。 */
export default function WorkspaceSwitcher() {
  const [switching, setSwitching] = useState(false)

  const handleSwitch = async () => {
    setSwitching(true)
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
    } finally {
      setSwitching(false)
    }
  }

  return (
    <Button
      size="small"
      type="text"
      block
      icon={<FolderOpenOutlined />}
      loading={switching}
      onClick={() => void handleSwitch()}
    >
      切换文件夹
    </Button>
  )
}
