import { Button, Divider, Form, Input, InputNumber, Modal, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { GIT_TIMEOUT_SEC_MAX, GIT_TIMEOUT_SEC_MIN, type TestConnectionResult } from '../../../../shared/ipc'
import { useSyncStore } from '../../stores/sync'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * M6/M11/M12：同步设置。repoUrl + PAT（Password）→ 保存即「测试连接 + 首同步」（configure 内建，
 * 失败回显错误）；已配置显示当前 repoUrl，可「重新配置」或「清除」。PAT 不落任何 state。
 *
 * 同步范围（M11）：账本 main.beancount + 账户库 + Excel 导入模板 + 受托管 .gitignore。
 * 索引缓存与本机同步配置（含 lastSyncAt）不进仓库——因此换电脑 clone 后**仍需重新填写
 * 仓库地址与 PAT**（PAT 本就只在本机加密存储）。
 *
 * M12「本机网络」：代理地址 + 超时。是**机器级**配置（换账本目录不用重填）、独立于上面的
 * 凭据单独保存；代理只手动填写，不读 Windows 系统代理 / HTTP_PROXY 环境变量。
 */
export default function SyncSettingsModal({ open, onClose }: Props) {
  const status = useSyncStore((s) => s.status)
  const configure = useSyncStore((s) => s.configure)
  const clear = useSyncStore((s) => s.clear)
  const network = useSyncStore((s) => s.network)
  const loadNetwork = useSyncStore((s) => s.loadNetwork)
  const saveNetwork = useSyncStore((s) => s.saveNetwork)
  const testConnection = useSyncStore((s) => s.testConnection)
  const [repoUrl, setRepoUrl] = useState('')
  const [pat, setPat] = useState('')
  const [saving, setSaving] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [timeoutSec, setTimeoutSec] = useState<number | null>(null)
  const [savingNetwork, setSavingNetwork] = useState(false)
  const [testing, setTesting] = useState(false)
  /** 连接测试诊断——留在弹窗里供用户对着改代理地址（几秒即散的 toast 是错误介质） */
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const configured = status?.configured ?? false

  useEffect(() => { if (open && configured) setRepoUrl(status?.repoUrl ?? '') }, [open, configured, status?.repoUrl])

  // 打开即拉机器级网络配置；每次打开都重置测试结论（配置可能已变）
  useEffect(() => {
    if (!open) return
    setTestResult(null)
    void loadNetwork()
  }, [open, loadNetwork])

  // 用已保存值回填表单（loadNetwork 每次返回新对象 → 重新打开必然回填，丢弃未保存的改动）
  useEffect(() => {
    if (!open || !network) return
    setProxyUrl(network.proxyUrl ?? '')
    setTimeoutSec(network.timeoutSec)
  }, [open, network])

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

  const handleSaveNetwork = async () => {
    setSavingNetwork(true)
    const text = proxyUrl.trim()
    await saveNetwork({ proxyUrl: text === '' ? null : text, timeoutSec: timeoutSec ?? network?.timeoutSec ?? 30 })
    setSavingNetwork(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(await testConnection(repoUrl.trim() || undefined))
    setTesting(false)
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
        <Form.Item label="Personal Access Token" required tooltip="需 repo scope；仅在本机加密存储，不上传任何第三方；换电脑需重新填写与仓库地址一栏">
          <Input.Password
            placeholder="ghp_..."
            value={pat}
            onChange={(e) => setPat(e.target.value)}
          />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        同步内容：账本、账户库（科目管理）、Excel 导入模板。索引缓存与本机配置不参与同步，换电脑后需重新填写仓库地址与令牌。
      </Typography.Text>

      <Divider style={{ margin: '16px 0 12px' }} orientation="left" plain>
        本机网络
      </Divider>
      <Form layout="vertical">
        <Form.Item
          label="代理地址"
          tooltip="仅支持 HTTP/HTTPS 代理，如 Clash 默认 127.0.0.1:7890、v2rayN 默认 127.0.0.1:10809。留空即直连（不走系统代理）"
        >
          <Input
            placeholder="http://127.0.0.1:7890"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="同步超时（秒）" tooltip="单个远端 git 操作的上限；慢网络可调大">
          <InputNumber
            min={GIT_TIMEOUT_SEC_MIN}
            max={GIT_TIMEOUT_SEC_MAX}
            precision={0}
            style={{ width: 120 }}
            value={timeoutSec}
            onChange={setTimeoutSec}
          />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        属于本机设置：换账本目录不用重填，也不会同步到仓库。改完先「保存网络设置」再「测试连接」——测试用的是已保存的配置。
      </Typography.Text>
      {testResult ? (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type={testResult.ok ? 'success' : 'danger'} style={{ fontSize: 12 }}>
            {testResult.message}
          </Typography.Text>
        </div>
      ) : null}
      <Space style={{ width: '100%', marginTop: 12 }}>
        <Button loading={savingNetwork} onClick={() => void handleSaveNetwork()}>保存网络设置</Button>
        <Button loading={testing} onClick={() => void handleTest()}>测试连接</Button>
      </Space>

      <Space style={{ width: '100%', justifyContent: 'flex-end', marginTop: 12 }}>
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
