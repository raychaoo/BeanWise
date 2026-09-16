/**
 * 录入视图：复用 EntryForm 凭证组件，右侧保留最近流水列表。
 * 录入仍默认两行；EntryForm 同时服务明细页编辑抽屉的多行回填。
 */
import { Button, Card, Dropdown, Empty, Form, message, Typography } from 'antd'
import type { MenuProps } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AddEntryParams } from '../../../../shared/ipc'
import { useEntryFormStore } from '../../stores/entry-form'
import { useLedgerStore } from '../../stores/ledger'
import { useAiStore } from '../../stores/ai'
import '../../styles/views/entry.less'
import AmountCell from '../entries/AmountCell'
import AiEntryDrawer from './AiEntryDrawer'
import EntryForm from './EntryForm'
import ExcelImportDrawer from './ExcelImportDrawer'
import { draftToFormValues } from './entryFormValues'
import type { EntryFormValues } from './entryFormValues'

export { draftToFormValues, nextBalancingNumber } from './entryFormValues'

export default function EntryFormView() {
  const [form] = Form.useForm<EntryFormValues>()
  const navigate = useNavigate()
  const status = useLedgerStore((s) => s.status)
  const loadAccounts = useLedgerStore((s) => s.loadAccounts)
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const recentEntries = useLedgerStore((s) => s.entries)
  const aiConfigured = useAiStore((s) => s.status?.configured ?? false)
  const [excelOpen, setExcelOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))
  const defaultCurrency = status?.operatingCurrency?.[0] ?? 'CNY'
  const initialValues = useMemo<EntryFormValues>(
    () => ({
      date: dayjs(),
      flag: '*',
      postings: [{ currency: defaultCurrency }, { currency: defaultCurrency }]
    }),
    [defaultCurrency]
  )

  useEffect(() => {
    void loadAccounts()
    void useLedgerStore.getState().refresh()
  }, [loadAccounts])

  const handleFinish = async (params: AddEntryParams) => {
    const result = await window.beanwise.addLedgerEntry(params)
    if (result.ok) {
      message.success('已写入并校验通过')
      form.resetFields()
      useEntryFormStore.getState().setDirty(false)
      await useLedgerStore.getState().refresh()
    } else {
      message.error(result.message ?? '写入失败')
    }
  }

  const handleFillForm = (draft: AddEntryParams) => {
    form.setFieldsValue(draftToFormValues(draft))
    useEntryFormStore.getState().setDirty(true)
    message.success('已填入表单，请确认后提交')
    setAiOpen(false)
  }

  const moreMenu: MenuProps['items'] = [
    {
      key: 'excel',
      label: 'Excel 导入',
      onClick: () => setExcelOpen(true)
    },
    aiConfigured
      ? {
          key: 'ai',
          label: 'AI 辅助录入',
          onClick: () => setAiOpen(true)
        }
      : null,
    {
      key: 'accounts',
      label: '账户设置',
      onClick: () => navigate('/accounts')
    }
  ].filter(Boolean) as MenuProps['items']

  return (
    <div className="entry-two-col">
      <Card
        className="entry-col-form"
        title="录入凭证"
        extra={
          <Dropdown menu={{ items: moreMenu }} trigger={['click']}>
            <Button type="text" className="entry-more-trigger">
              更多
            </Button>
          </Dropdown>
        }
      >
        <EntryForm
          form={form}
          mode="create"
          initialValues={initialValues}
          onSubmit={handleFinish}
        />
        <ExcelImportDrawer open={excelOpen} onClose={() => setExcelOpen(false)} onImported={() => void loadAccounts()} />
        <AiEntryDrawer open={aiOpen} onClose={() => setAiOpen(false)} onFillForm={handleFillForm} />
      </Card>

      <Card
        className="entry-col-side"
        title="最近流水"
        extra={recentEntries.length > 0 ? <Link to="/entries">查看全部</Link> : undefined}
        styles={{ body: { flex: 1, overflow: 'auto', padding: 0 } }}
      >
        {recentEntries.length === 0 ? (
          <Empty className="entry-recent-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流水，录入后即时显示" />
        ) : (
          <ul className="entry-recent-list">
            {recentEntries.slice(0, 20).map((e) => {
              const accountLabel = e.pnlAccount !== null ? (accountNameMap.get(e.pnlAccount) ?? e.pnlAccount) : null
              const headline = e.payee ?? e.narration ?? '—'
              return (
                <li key={e.id} className="entry-recent-item">
                  <span className="entry-recent-date">{e.date}</span>
                  <span className="entry-recent-main">
                    <span className="entry-recent-headline">{headline}</span>
                    {accountLabel && accountLabel !== headline && (
                      <span className="entry-recent-account">{accountLabel}</span>
                    )}
                  </span>
                  {/* 与明细页 / 对账明细账共用 AmountCell：类型标签 + 按交易性质着色（口径单源，
                      顺带补上 flowAmount 兜底——借出/还款/转账的 amount 按设计为 null） */}
                  <span className="entry-recent-amount">
                    <AmountCell row={e} />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
