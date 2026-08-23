/**
 * 明细视图（M4）：索引状态卡 + 条目分页表。M3 只读验收面板由此取代。
 */
import { DeleteOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Descriptions, message, Modal, Space, Table, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import type { LedgerEntryRow } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'

const PAGE_SIZE = 20

const STATUS_COLOR: Record<string, string> = { ok: 'success', error: 'error', missing: 'default' }

export default function EntriesView() {
  const status = useLedgerStore((s) => s.status)
  const entries = useLedgerStore((s) => s.entries)
  const total = useLedgerStore((s) => s.total)
  const loading = useLedgerStore((s) => s.loading)
  const error = useLedgerStore((s) => s.error)
  const refresh = useLedgerStore((s) => s.refresh)
  const loadEntries = useLedgerStore((s) => s.loadEntries)
  const setError = useLedgerStore((s) => s.setError)
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const [page, setPage] = useState(1)
  const [clearing, setClearing] = useState(false)

  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))

  const columns: ColumnsType<LedgerEntryRow> = [
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '标志', dataIndex: 'flag', width: 60, render: (v: string | null) => v ?? '—' },
    { title: '类型', dataIndex: 'type', width: 90 },
    { title: '交易对象', dataIndex: 'payee', render: (v: string | null) => v ?? '—' },
    { title: '说明', dataIndex: 'narration', render: (v: string | null) => v ?? '—' },
    {
      title: '账户',
      dataIndex: 'account',
      render: (v: string | null) => {
        if (!v) return '—'
        const label = accountNameMap.get(v) ?? v
        return label === v ? v : <Tooltip title={v}>{label}</Tooltip>
      }
    }
  ]

  /** 重建索引 → 重拉状态与条目（M3 refreshIndex 管线） */
  const handleRefreshIndex = async () => {
    try {
      await window.beanwise.refreshLedgerIndex()
    } catch (err) {
      setError(String(err))
    }
    await refresh()
  }

  const handleClear = () => {
    Modal.confirm({
      title: '清空账本',
      content: '将删除账本中的所有交易记录与账户 open 记录，账户设置会保留。此操作不可撤销。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setClearing(true)
        try {
          const result = typeof window.beanwise.clearLedger === 'function'
            ? await window.beanwise.clearLedger()
            : await clearViaSaveFile()
          if (result.ok) {
            message.success('账本已清空')
            setPage(1)
            await refresh()
            await useLedgerStore.getState().loadAccounts()
          } else {
            message.error(result.message ?? '清空失败')
          }
        } catch (err) {
          message.error(String(err))
        } finally {
          setClearing(false)
        }
      }
    })
  }

  /** 旧版 preload 没有 clearLedger 时，复用读取 + 整文件覆盖保存清空账本。 */
  const clearViaSaveFile = async () => {
    const read = await window.beanwise.readLedgerFile()
    if (!read.ok || !read.fingerprint) throw new Error(read.message ?? '读取账本失败')
    return window.beanwise.saveLedgerFile({ content: '', expectedFingerprint: read.fingerprint })
  }

  return (
    <div>
      {error && (
        <Alert type="error" message={error} showIcon closable onClose={() => setError(null)} style={{ marginBottom: 16 }} />
      )}
      <Card
        title="索引状态"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button onClick={() => void handleRefreshIndex()}>重建索引</Button>
            <Button danger icon={<DeleteOutlined />} loading={clearing} onClick={handleClear}>清空账本</Button>
          </Space>
        }
      >
        <Descriptions column={2} size="small">
          <Descriptions.Item label="路径">{status?.path ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={STATUS_COLOR[status?.status ?? 'missing']}>{status?.status ?? 'missing'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="条目数">{status?.entryCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="错误数">{status?.errorCount ?? 0}</Descriptions.Item>
          <Descriptions.Item label="更新时间" span={2}>
            {status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—'}
          </Descriptions.Item>
          {status?.lastError && (
            <Descriptions.Item label="最近错误" span={2}>
              <span className="error-text">{status.lastError}</span>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>
      <Card title={`条目（${total}）`}>
        <Table<LedgerEntryRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={entries}
          columns={columns}
          pagination={{
            pageSize: PAGE_SIZE,
            total,
            current: page,
            showSizeChanger: false,
            onChange: (p) => {
              setPage(p)
              void loadEntries(PAGE_SIZE, (p - 1) * PAGE_SIZE)
            }
          }}
        />
      </Card>
    </div>
  )
}
