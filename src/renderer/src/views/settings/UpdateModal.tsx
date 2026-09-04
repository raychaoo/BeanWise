/**
 * M8 更新 Modal（T6）：当前版本 + 检查更新 + 下载进度 + 错误态 + 安装按钮。
 * 状态来自 update store（初始拉取 + 事件推送）。沿用 AiSettingsModal Modal 模式。
 */
import { Alert, Button, Modal, Progress, Space, Typography } from 'antd'
import { useUpdateStore } from '../../stores/update'

export default function UpdateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useUpdateStore((s) => s.state)
  const check = useUpdateStore((s) => s.check)
  const install = useUpdateStore((s) => s.install)

  const checking = state?.status === 'checking'
  const downloading = state?.status === 'downloading'

  return (
    <Modal title="更新" open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text>当前版本：v{state?.currentVersion ?? '—'}</Typography.Text>
        {state?.status === 'available' && state.availableVersion && (
          <Typography.Text type="warning">发现新版本 v{state.availableVersion}</Typography.Text>
        )}
        {state?.status === 'downloaded' && (
          <Space>
            <Typography.Text type="success">下载完成，安装后将重启应用</Typography.Text>
            <Button type="primary" onClick={() => void install()}>立即安装</Button>
          </Space>
        )}
        {downloading && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>正在下载…</Typography.Text>
            <Progress percent={state?.progress ?? 0} />
          </Space>
        )}
        {state?.status === 'idle' && <Typography.Text type="secondary">已是最新版本</Typography.Text>}
        {state?.status === 'error' && <Alert type="error" showIcon message={`更新失败：${state?.error ?? ''}`} />}
        <Button type="primary" disabled={checking || downloading} loading={checking} onClick={() => void check()}>
          检查更新
        </Button>
      </Space>
    </Modal>
  )
}
