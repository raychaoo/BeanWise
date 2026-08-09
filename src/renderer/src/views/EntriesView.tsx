/**
 * 明细视图（M4）：索引状态卡 + 条目分页表。M3 只读验收面板由此取代。
 */
import { Alert, Button, Card, Descriptions, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import type { LedgerEntryRow } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'

const PAGE_SIZE = 20

const columns: ColumnsType<LedgerEntryRow> = [
  { title: '日期', dataIndex: 'date', width: 110 },
  { title: '标志', dataIndex: 'flag', width: 60, render: (v: string | null) => v ?? '—' },
  { title: '类型', dataIndex: 'type', width: 90 },
  { title: 'Payee', dataIndex: 'payee', render: (v: string | null) => v ?? '—' },
  { title: 'Narration', dataIndex: 'narration', render: (v: string | null) => v ?? '—' },
  { title: '账户', dataIndex: 'account', render: (v: string | null) => v ?? '—' }
]

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
  const [page, setPage] = useState(1)

  /** 重建索引 → 重拉状态与条目（M3 refreshIndex 管线） */
  const handleRefreshIndex = async () => {
    try {
      await window.beanwise.refreshLedgerIndex()
    } catch (err) {
      setError(String(err))
    }
    await refresh()
  }

  return (
    <div>
      {error && (
        <Alert type="error" message={error} showIcon closable onClose={() => setError(null)} style={{ marginBottom: 16 }} />
      )}
      <Card
        title="索引状态"
        style={{ marginBottom: 16 }}
        extra={<Button onClick={() => void handleRefreshIndex()}>重建索引</Button>}
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
