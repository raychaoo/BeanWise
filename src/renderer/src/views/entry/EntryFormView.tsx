/**
 * 录入视图（重设计）：分区化凭证头（日期/标志 + 交易对象/说明纵向）+ 加重的记账行（账户为主输入，
 * 金额/货币副输入 + 借方/贷方标签 + 账户类型决定的余额变动方向）+ 加权的余额指示条 + 强化的提交区
 * + 可读的最近流水列表（等宽数字 + 正负色 + 单行信息层级）。次要操作（Excel/AI/账户设置）收进
 * header「更多」菜单，凭证首屏回归表单。金额一律十进制字符串；记账方向与自动平衡决策抽为纯函数
 * postingDirection（单测覆盖）——方向由账户类型决定，账户填在哪一行都记对。
 */
import { ProForm, ProFormDatePicker, ProFormRadio, ProFormText } from '@ant-design/pro-components'
import { Button, Card, Col, Dropdown, Empty, Form, message, Row, Typography } from 'antd'
import type { MenuProps } from 'antd'
import type { Rule } from 'antd/es/form'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AddEntryParams } from '../../../../shared/ipc'
import { filterAccountOptions, isEntryAccountPairValid } from '../../../../shared/account'
import { computeBalancingNumber } from '../../../../shared/decimal'
import { useEntryFormStore } from '../../stores/entry-form'
import { useLedgerStore } from '../../stores/ledger'
import { useAiStore } from '../../stores/ai'
import { formatAmount } from '../../utils/format'
import '../../styles/views/entry.less'
import BalanceHint from './BalanceHint'
import PostingRowCard from './PostingRowCard'
import { buildEntryPostings, postingEffectLabel, resolvePostingSigns } from './postingDirection'
import type { PostingSign } from './postingDirection'
import AiEntryDrawer from './AiEntryDrawer'
import ExcelImportDrawer from './ExcelImportDrawer'

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

interface PostingRow {
  account?: string
  number?: string | null
  currency?: string
}

interface EntryFormValues {
  date?: string | dayjs.Dayjs
  flag?: '*' | '!'
  payee?: string
  narration?: string
  postings: PostingRow[]
}

export default function EntryFormView() {
  const [form] = Form.useForm<EntryFormValues>()
  const navigate = useNavigate()
  const status = useLedgerStore((s) => s.status)
  const loadAccounts = useLedgerStore((s) => s.loadAccounts)
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const recentEntries = useLedgerStore((s) => s.entries)
  const aiConfigured = useAiStore((s) => s.status?.configured ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [excelOpen, setExcelOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const postings = Form.useWatch('postings', form)
  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))

  useEffect(() => {
    void loadAccounts()
    void useLedgerStore.getState().refresh()
  }, [loadAccounts])

  // 自动平衡：第一行金额变化时，第二行 = 第一行取反（受控只读，保证两行合计恒为 0）
  useEffect(() => {
    if (!Array.isArray(postings) || postings.length < 2) return
    const first = postings[0]
    const second = postings[1]
    const firstNum = first?.number?.trim()
    if (!firstNum) return
    // 第二行始终跟随第一行取反，避免残留旧值导致借贷不平衡
    const expected = computeBalancingNumber([firstNum])
    if (second?.number !== expected) {
      form.setFieldValue(['postings', 1, 'number'], expected)
    }
  }, [postings, form])

  // Ctrl+Enter 提交
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault()
        form.submit()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [form])

  const currencyOptions = (status?.operatingCurrency ?? []).map((c) => ({ value: c }))
  const defaultCurrency = status?.operatingCurrency?.[0] ?? 'CNY'
  const accountOptionsFor = (rowIndex: number) =>
    filterAccountOptions(accountOptions, postings?.[1 - rowIndex]?.account)

  // 记账方向：由账户类型推导（收入记负、支出记正），与 Excel 导入同一套约定——
  // 账户填在哪一行都记对，不再依赖行序。
  const postingSigns = resolvePostingSigns(postings?.[0]?.account, postings?.[1]?.account)
  const signForRow = (rowIndex: number): PostingSign =>
    postingSigns[rowIndex] ?? (rowIndex % 2 === 0 ? 1 : -1)

  const numberRule = (fieldName: number): Rule => ({
    validator: (_rule, value: string | undefined | null) => {
      const lastIdx = (postings?.length ?? 0) - 1
      const empty = value === undefined || value === null || value === ''
      if ((postings?.length ?? 0) >= 2 && fieldName === lastIdx && empty) {
        return Promise.resolve()
      }
      if (empty) return Promise.reject(new Error('请输入金额'))
      if (!DECIMAL_RE.test(value)) return Promise.reject(new Error('金额格式非法'))
      return Promise.resolve()
    }
  })

  const accountRules: Rule[] = [
    { required: true, message: '请输入账户' },
    { pattern: /^[A-Z]\S*:\S*$/, message: '账户须大写字母开头、含冒号、无空格' }
  ]

  const handleFinish = async (values: EntryFormValues) => {
    const params: AddEntryParams = {
      date:
        values.date !== undefined && values.date !== ''
          ? (typeof values.date === 'string' ? values.date : values.date.format('YYYY-MM-DD'))
          : dayjs().format('YYYY-MM-DD'),
      ...(values.flag ? { flag: values.flag } : {}),
      ...(values.payee?.trim() ? { payee: values.payee.trim() } : {}),
      ...(values.narration?.trim() ? { narration: values.narration.trim() } : {}),
      postings: buildEntryPostings(
        (values.postings ?? []).filter((p) => p.account || p.number || p.currency)
      )
    }
    setSubmitting(true)
    try {
      const result = await window.beanwise.addLedgerEntry(params)
      if (result.ok) {
        message.success('已写入并校验通过')
        form.resetFields()
        useEntryFormStore.getState().setDirty(false)
        await useLedgerStore.getState().refresh()
      } else {
        message.error(result.message ?? '写入失败')
      }
    } catch (err) {
      message.error(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  /** 草稿 → 表单回填 */
  const handleFillForm = (draft: AddEntryParams) => {
    form.setFieldsValue(draftToFormValues(draft))
    useEntryFormStore.getState().setDirty(true)
    message.success('已填入表单，请确认后提交')
    setAiOpen(false)
  }

  /** 次要操作菜单 */
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
        <ProForm<EntryFormValues>
          form={form}
          onFinish={handleFinish}
          onValuesChange={() => useEntryFormStore.getState().setDirty(true)}
          initialValues={{
            date: dayjs(),
            flag: '*',
            postings: [
              { currency: defaultCurrency },
              { currency: defaultCurrency }
            ]
          }}
          submitter={false}
        >
          {/* 分区 1：凭证头 */}
          <div className="entry-section">
            <Row gutter={16}>
              <Col span={8}>
                <ProFormDatePicker name="date" label="日期" fieldProps={{ format: 'YYYY-MM-DD' }} />
              </Col>
              <Col span={16}>
                <ProFormRadio.Group
                  name="flag"
                  label="标志"
                  options={[
                    { label: '* 已确认', value: '*' },
                    { label: '! 未确认', value: '!' }
                  ]}
                />
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={12}>
                <ProFormText name="payee" label="交易对象" fieldProps={{ maxLength: 200 }} />
              </Col>
              <Col span={12}>
                <ProFormText name="narration" label="说明" fieldProps={{ maxLength: 200 }} />
              </Col>
            </Row>
          </div>

          {/* 分区 2：记账行 */}
          <div className="entry-section">
            <span className="entry-section__title">记账行</span>
            <Typography.Paragraph type="secondary" className="entry-postings-tip">
              两行分别记录资金涉及的两个账户；金额只需填在第一行（填正数即可），记账方向由账户类型自动判定
              （支出记正、收入记负），第二行金额自动取反，两行合计恒为 0。
            </Typography.Paragraph>

            <Form.List
              name="postings"
              rules={[
                {
                  validator: async (_rule, rows: PostingRow[] | undefined) => {
                    if (!rows || rows.length !== 2) throw new Error('记账行必须是两行')
                    const accounts = rows.map((r) => r?.account?.trim()).filter((v): v is string => !!v)
                    if (accounts.length === 2 && !isEntryAccountPairValid(accounts[0], accounts[1])) {
                      throw new Error('两行不能同为收支账户，至少一边应为资产/负债/权益账户')
                    }
                  }
                }
              ]}
            >
              {(fields) => (
                <>
                  {fields.map((field) => (
                    <PostingRowCard
                      key={field.key}
                      index={field.name as 0 | 1}
                      sign={signForRow(field.name)}
                      effectLabel={postingEffectLabel(postings?.[field.name]?.account, signForRow(field.name))}
                      amountReadOnly={field.name === 1}
                      currencyOptions={currencyOptions}
                      accountOptions={accountOptionsFor(field.name)}
                      accountRules={accountRules}
                      numberRules={[numberRule(field.name)]}
                    />
                  ))}
                </>
              )}
            </Form.List>
            <BalanceHint rows={postings} />
          </div>

          {/* 分区 3：提交区 */}
          <div className="entry-section">
            <div className="entry-submit-bar">
              <Button type="primary" loading={submitting} onClick={() => form.submit()}>
                写入账本
              </Button>
              <Typography.Text className="entry-submit-tip" type="secondary">
                Ctrl + Enter 快速提交
              </Typography.Text>
            </div>
          </div>
        </ProForm>

        <ExcelImportDrawer open={excelOpen} onClose={() => setExcelOpen(false)} onImported={() => void loadAccounts()} />
        <AiEntryDrawer open={aiOpen} onClose={() => setAiOpen(false)} onFillForm={handleFillForm} />
      </Card>

      {/* 右侧：最近流水 */}
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
              const negative = e.amount !== null && e.amount.startsWith('-')
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
                  <span className={`entry-recent-amount${negative ? ' num-negative' : ''}`}>
                    {e.amount !== null ? `${formatAmount(e.amount)} ${e.currency ?? ''}`.trimEnd() : '—'}
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

/** 自动平衡决策（纯函数，单测覆盖） */
export function nextBalancingNumber(
  rows: Array<{ number?: string | null } | undefined> | undefined
): string | undefined {
  if (!rows || rows.length < 2) return undefined
  const lastIdx = rows.length - 1
  const last = rows[lastIdx]
  const lastVal = last?.number
  if (lastVal !== undefined && lastVal !== null && lastVal.trim() !== '') return undefined
  const amounts = rows
    .slice(0, lastIdx)
    .map((r) => r?.number?.trim())
    .filter((v): v is string => !!v)
  if (amounts.length === 0) return undefined
  try {
    return computeBalancingNumber(amounts)
  } catch {
    return undefined
  }
}

type DraftFormValues = Omit<EntryFormValues, 'date'> & { date: dayjs.Dayjs }

export function draftToFormValues(draft: AddEntryParams): DraftFormValues {
  return {
    date: dayjs(draft.date),
    flag: draft.flag ?? '*',
    payee: draft.payee,
    narration: draft.narration,
    postings: draft.postings.map((p) => ({ account: p.account, number: p.number, currency: p.currency }))
  }
}
