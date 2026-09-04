/**
 * M7：AI 设置。DeepSeek API Key（Password）→ 保存即调 ai:save-config（safeStorage 加密，
 * 主进程持有）；已配置显示当前模型，可「清除配置」。Key 不落任何 state。
 */
import { Button, Form, Input, Modal, Space, Typography } from 'antd'
import { useState } from 'react'
import { useAiStore } from '../../stores/ai'

interface Props {
  open: boolean
  onClose: () => void
}

export default function AiSettingsModal({ open, onClose }: Props) {
  const status = useAiStore((s) => s.status)
  const saveConfig = useAiStore((s) => s.saveConfig)
  const clearConfig = useAiStore((s) => s.clearConfig)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const configured = status?.configured ?? false

  const handleSave = async () => {
    if (!apiKey.trim()) return
    setSaving(true)
    const ok = await saveConfig(apiKey.trim())
    setSaving(false)
    if (ok) onClose()
  }

  const handleClear = async () => {
    await clearConfig()
    onClose()
  }

  return (
    <Modal title="AI 设置" open={open} onCancel={onClose} footer={null} destroyOnClose>
      {configured ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">当前模型：{status?.model}</Typography.Text>
          <Typography.Text type="secondary">API Key 已加密存储在本地，渲染进程不可见</Typography.Text>
        </Space>
      ) : null}
      <Form layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label="DeepSeek API Key" required tooltip="仅在本地加密存储（safeStorage），不上传任何第三方">
          <Input.Password
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Form.Item>
      </Form>
      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        {configured ? <Button danger onClick={() => void handleClear()}>清除配置</Button> : null}
        <Button type="primary" loading={saving} onClick={() => void handleSave()}>
          {configured ? '重新配置' : '保存'}
        </Button>
      </Space>
    </Modal>
  )
}
