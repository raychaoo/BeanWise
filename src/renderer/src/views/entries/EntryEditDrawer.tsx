/** 明细页二次编辑抽屉：按稳定 ID 读取完整交易，复用 EntryForm 回填并保存。 */
import { Alert, Drawer, Form, message, Spin, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { AddEntryParams, LedgerEntryDetail } from '../../../../shared/ipc'
import { useLedgerStore } from '../../stores/ledger'
import EntryForm from '../entry/EntryForm'
import { draftToFormValues } from '../entry/entryFormValues'
import type { EntryFormValues } from '../entry/entryFormValues'

interface Props {
  open: boolean
  entryId: string | null
  onClose: () => void
  onSaved: () => Promise<void> | void
}

export default function EntryEditDrawer({ open, entryId, onClose, onSaved }: Props) {
  const [form] = Form.useForm<EntryFormValues>()
  const [entry, setEntry] = useState<LedgerEntryDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !entryId) {
      setEntry(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.beanwise
      .getLedgerEntry({ id: entryId })
      .then((result) => {
        if (cancelled) return
        if (!result.ok || !result.entry) {
          setError(result.message ?? '读取交易失败')
          return
        }
        setEntry(result.entry)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, entryId])

  useEffect(() => {
    if (open) void useLedgerStore.getState().loadAccounts()
  }, [open])

  const initialValues = useMemo(() => (entry ? draftToFormValues(entry) : null), [entry])

  const handleSubmit = async (params: AddEntryParams) => {
    const result = await window.beanwise.updateLedgerEntry({ ...params, id: entryId! })
    if (!result.ok) {
      message.error(result.message ?? '更新失败')
      return
    }
    message.success('已更新并校验通过')
    onClose()
    await onSaved()
  }

  return (
    <Drawer
      title="编辑凭证"
      width={760}
      open={open}
      onClose={onClose}
      destroyOnHidden
      className="entry-edit-drawer"
    >
      {loading ? (
        <div className="entry-edit-loading">
          <Spin />
        </div>
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : entry && initialValues ? (
        <>
          <div className="entry-edit-id">
            <span>ID</span>
            <Typography.Text code copyable={{ text: entry.id }}>
              {entry.id}
            </Typography.Text>
          </div>
          <EntryForm
            form={form}
            mode="edit"
            initialValues={initialValues}
            meta={{ id: entry.id, links: entry.links, preserveSigns: true }}
            onSubmit={handleSubmit}
          />
        </>
      ) : null}
    </Drawer>
  )
}
