/**
 * 录入视图（M4；批次 B 双栏重排；批次 D 补收最近流水卡）：左栏凭证卡（凭证头 2 列栅格 + 借贷分录卡
 * + 平衡指示条 + 提交区），右栏「最近流水」卡 = 最近 8 条分录（日期/对象/账户/交易金额），录入成功
 * 随 refresh() 即时刷新；金额来自 listEntries 的 amount 增强字段（超 UI 层 #1，资产流视角：支出负/收入正）。
 * ProForm + Form.List 固定两行 postings + 自动平衡。金额一律十进制字符串（InputNumber stringMode
 * 直取字符串，禁浮点）；自动平衡决策抽为纯函数 nextBalancingNumber（见文件底部，单测覆盖）——
 * 写路径（ProForm → add-entry、自动平衡、stringMode）逻辑零改动。
 * 分录行展示拆至 entry/PostingRowCard（纯展示，name/rules 仍由本组件传入）。
 */
import { ProForm, ProFormDatePicker, ProFormRadio, ProFormText } from '@ant-design/pro-components'
import { Card, Empty, Form, message, Typography } from 'antd'
import type { Rule } from 'antd/es/form'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AddEntryParams } from '../../../shared/ipc'
import { filterAccountOptions, isEntryAccountPairValid } from '../../../shared/account'
import { computeBalancingNumber } from '../../../shared/decimal'
import { useEntryFormStore } from '../stores/entry-form'
import { useLedgerStore } from '../stores/ledger'
import { formatAmount } from '../utils/format'
import '../styles/views/entry.less'
import EntryActionsBar from './entry/EntryActionsBar'
import BalanceHint from './entry/BalanceHint'
import PostingRowCard from './entry/PostingRowCard'

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

interface PostingRow {
  account?: string
  number?: string | null
  currency?: string
}

interface EntryFormValues {
  /** ProFormDatePicker 设 format 后 onFinish 提交值为 YYYY-MM-DD 字符串；填表路径可能为 dayjs */
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
  const [submitting, setSubmitting] = useState(false)
  const postings = Form.useWatch('postings', form)
  const accountNameMap = new Map(accountOptions.map((o) => [o.value, o.label]))

  useEffect(() => {
    void loadAccounts()
    // 最近流水卡数据自愈：明细页分页查询会把共享 entries 覆盖为单页，进录入页时重拉最近 100 条
    void useLedgerStore.getState().refresh()
  }, [loadAccounts])

  // 自动平衡：末行金额为空时，按前 n-1 行之和补差（始终写入，含 '0'——
  // 若跳过而其余行和为 0，序列化会产出空金额 posting 导致解析失败回滚）
  useEffect(() => {
    if (!Array.isArray(postings)) return
    const balancing = nextBalancingNumber(postings)
    if (balancing !== undefined) {
      form.setFieldValue(['postings', postings.length - 1, 'number'], balancing)
    }
  }, [postings, form])

  // Ctrl+Enter 提交凭证（方案交互清单 2）：挂全局 keydown，卸载移除
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
  const accountOptionsFor = (rowIndex: number) =>
    filterAccountOptions(accountOptions, postings?.[1 - rowIndex]?.account)

  const numberRule = (fieldName: number): Rule => ({
    validator: (_rule, value: string | undefined | null) => {
      const lastIdx = (postings?.length ?? 0) - 1
      const empty = value === undefined || value === null || value === ''
      if ((postings?.length ?? 0) >= 2 && fieldName === lastIdx && empty) {
        return Promise.resolve() // 末行留空：自动平衡补差
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
      postings: (values.postings ?? [])
        .filter((p) => p.account || p.number || p.currency) // 过滤空行
        .map((p) => ({ account: p.account ?? '', number: p.number ?? '', currency: p.currency ?? '' }))
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

  /** 草稿 → 表单回填（写路径唯一：确认仍走本表单的「写入账本」提交）；回填内容视为未保存草稿 */
  const handleFillForm = (draft: AddEntryParams) => {
    form.setFieldsValue(draftToFormValues(draft))
    useEntryFormStore.getState().setDirty(true)
    message.success('已填入表单，请确认后提交')
  }

  return (
    <div className="entry-two-col">
      <Card
        className="entry-col-form"
        title="录入凭证"
        extra={
          <EntryActionsBar
            onFillForm={handleFillForm}
            onImported={() => void loadAccounts()}
            onOpenAccountSettings={() => navigate('/accounts')}
          />
        }
      >
        <ProForm<EntryFormValues>
          form={form}
          onFinish={handleFinish}
          onValuesChange={() => useEntryFormStore.getState().setDirty(true)}
          initialValues={{ date: dayjs(), flag: '*', postings: [{}, {}] }}
          submitter={{
            searchConfig: { submitText: '写入账本' },
            submitButtonProps: { loading: submitting }
          }}
        >
          <div className="entry-voucher-head">
            <ProFormDatePicker name="date" label="日期" fieldProps={{ format: 'YYYY-MM-DD' }} />
            <ProFormRadio.Group
              name="flag"
              label="标志"
              options={[
                { label: '* 已确认', value: '*' },
                { label: '! 未确认', value: '!' }
              ]}
            />
            <ProFormText name="payee" label="交易对象" fieldProps={{ maxLength: 200 }} />
            <ProFormText name="narration" label="说明" fieldProps={{ maxLength: 200 }} />
          </div>

          <div className="entry-postings-head">
            <Typography.Text strong>记账行</Typography.Text>
          </div>
          <Typography.Paragraph type="secondary" className="entry-postings-tip">
            两行分别记录交易涉及的两个账户：一行是资金减少/支出方，另一行是资金增加/收入方；两行金额合计必须为 0，第二行金额留空会自动补差。
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
        </ProForm>
      </Card>
      <Card
        className="entry-col-side"
        title="最近流水"
        extra={recentEntries.length > 0 ? <Link to="/entries">查看全部</Link> : undefined}
      >
        {recentEntries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流水，录入后即时显示" />
        ) : (
          <ul className="entry-recent-list">
            {recentEntries.slice(0, 8).map((e) => {
              const account = e.account
              const label = account !== null ? (accountNameMap.get(account) ?? account) : null
              return (
                <li key={e.id} className="entry-recent-item">
                  <span className="entry-recent-date">{e.date}</span>
                  <span className="entry-recent-main" title={e.narration ?? undefined}>
                    {e.payee ?? e.narration ?? '—'}
                  </span>
                  <span className="entry-recent-account" title={account ?? undefined}>
                    {label ?? '—'}
                  </span>
                  <span
                    className={`entry-recent-amount num${e.amount !== null && e.amount.startsWith('-') ? ' num-negative' : ''}`}
                  >
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

/**
 * 自动平衡决策（纯函数，单测覆盖）：
 * 行数 ≥2 且末行金额为空 → 前 n-1 行非空金额之和取反（和为 0 时也写入 '0'——
 * 否则其余行和为零而末行留空，序列化会产出空金额 posting 导致解析失败回滚）；
 * 前 n-1 行全部为空 → undefined（不写：避免挂载时写入的 '0' 被当成用户输入，
 * 挡住后续真实补差）；末行非空（用户输入中）或行数不足 → undefined（不动）。
 */
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
  if (amounts.length === 0) return undefined // 尚未输入任何金额：不写，等用户输入
  try {
    return computeBalancingNumber(amounts)
  } catch {
    return undefined // 非法输入：交给表单校验提示，不在输入时抛错
  }
}

/** draftToFormValues 返回类型：date 恒为 dayjs（填表初值类型）；其余字段同 EntryFormValues。
 * 注意：返回类型收窄为 date: dayjs.Dayjs（而非 EntryFormValues.date 的 string | Dayjs 宽类型）——
 * 简报测试 draftToFormValues 用例以 v.date?.isSame(...) 断言 dayjs 语义，宽类型在 strict 下编译不过；
 * 收窄后仍可赋值给 Partial<EntryFormValues>，handleFinish 提交路径不受影响。 */
type DraftFormValues = Omit<EntryFormValues, 'date'> & { date: dayjs.Dayjs }

/** 草稿 → 表单值（date 转 dayjs 匹配 ProFormDatePicker 初值类型；M7-T5 导出供 node 单测） */
export function draftToFormValues(draft: AddEntryParams): DraftFormValues {
  return {
    date: dayjs(draft.date),
    flag: draft.flag ?? '*',
    payee: draft.payee,
    narration: draft.narration,
    postings: draft.postings.map((p) => ({ account: p.account, number: p.number, currency: p.currency }))
  }
}
