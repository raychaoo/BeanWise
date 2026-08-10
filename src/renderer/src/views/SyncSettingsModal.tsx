import { Button, Form, Input, Modal, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useSyncStore } from '../stores/sync'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * M6：同步设置。repoUrl + PAT（Password）→ 保存即「测试连接 + 首同步」（configure 内建，
 * 失败回显错误）；已配置显示当前 repoUrl，可「重新配置」或「清除」。PAT 不落任何 state。
 */
export default function SyncSettingsModal({ open, onClose }: Props) {
  const status = useSyncStore((s) => s.status)
  const configure = useSyncStore((s) => s.configure)
  const clear = useSyncStore((s) => s.clear)
  const [repoUrl, setRepoUrl] = useState('')
  const [pat, setPat] = useState('')
  const [saving, setSaving] = useState(false)
  const configured = status?.configured ?? false

  useEffect(() => { if (open && configured) setRepoUrl(status?.repoUrl ?? '') }, [open, configured, status?.repoUrl])

  const handleSave = async () => {
    if (!repoUrl.trim() || !pat.trim()) return
    setSaving(true)
    const ok = await configure(repoUrl.trim(), pat.trim())
    setSaving(false)
    if (ok) onClose()
  }

  const handleClear = async () => {
    await clear()
    onClose()
  }

  return (
    <Modal
      title="Git 同步设置"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      {configured ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">当前仓库：{status?.repoUrl}</Typography.Text>
          <Typography.Text type="secondary">
            上次同步：{status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '从未'}
          </Typography.Text>
        </Space>
      ) : null}
      <Form layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label="仓库地址" required tooltip="GitHub 私有仓库地址，如 https://github.com/yourname/beanwise">
          <Input
            placeholder="https://github.com/yourname/beanwise"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="Personal Access Token" required tooltip="需 repo scope；仅在本地加密存储，不上传任何第三方">
          <Input.Password
            placeholder="ghp_..."
            value={pat}
            onChange={(e) => setPat(e.target.value)}
          />
        </Form.Item>
      </Form>
      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        {configured ? (
          <Button danger onClick={() => void handleClear()}>清除配置</Button>
        ) : null}
        <Button type="primary" loading={saving} onClick={() => void handleSave()}>
          {configured ? '保存并同步' : '配置并同步'}
        </Button>
      </Space>
    </Modal>
  )
}
