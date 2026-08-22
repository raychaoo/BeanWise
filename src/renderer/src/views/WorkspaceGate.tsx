import { Button, Result, Spin, Typography } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useState } from 'react'
import type { WorkspaceStatus } from '../../../shared/ipc'

interface Props {
  onOpened: (status: WorkspaceStatus) => void
}

/** 启动门控：未选择工作目录时全屏显示，选择后回调通知父组件进入主界面 */
export default function WorkspaceGate({ onOpened }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleChoose = async () => {
    setLoading(true)
    setError(null)
    try {
      const picked = await window.beanwise.chooseWorkspaceFolder()
      if (!picked.ok || picked.canceled || !picked.path) {
        setLoading(false)
        return
      }
      const result = await window.beanwise.openWorkspace(picked.path)
      if (result.ok && result.status) {
        onOpened(result.status)
      } else {
        setError(result.message ?? '未知错误')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f5'
    }}>
      <Result
        icon={<FolderOpenOutlined style={{ color: '#1677ff' }} />}
        title="选择工作目录"
        subTitle="BeanWise 需要一个文件夹来存储账本文件和本地 Git 版本记录。已有 .beancount 文件将被接管，否则会新建。"
        extra={
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Button type="primary" size="large" icon={<FolderOpenOutlined />} loading={loading} onClick={() => void handleChoose()}>
              选择文件夹
            </Button>
            {loading && !error ? <Spin size="small" /> : null}
            {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
          </div>
        }
      />
    </div>
  )
}
