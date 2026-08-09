/**
 * 录入视图（M4）：ProForm + Form.List 动态 postings + 自动平衡。
 * 金额一律十进制字符串（InputNumber stringMode 直取字符串，禁浮点）；
 * 自动平衡决策抽为纯函数 nextBalancingNumber（见文件底部，单测覆盖）。
 */
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { ProForm, ProFormDatePicker, ProFormRadio, ProFormText } from '@ant-design/pro-components'
import { AutoComplete, Button, Form, InputNumber, message } from 'antd'
import type { Rule } from 'antd/es/form'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import type { AddEntryParams } from '../../../shared/ipc'
import { computeBalancingNumber } from '../../../shared/decimal'
import { useLedgerStore } from '../stores/ledger'

const MAX_POSTINGS = 20
const DECIMAL_RE = /^-?\d+(\.\d+)?$/

interface PostingRow {
  account?: string
  number?: string | null
  currency?: string
}

interface EntryFormValues {
  date?: dayjs.Dayjs
  flag?: '*' | '!'
  payee?: string
  narration?: string
  postings: PostingRow[]
}

export default function EntryFormView() {
  const [form] = Form.useForm<EntryFormValues>()
  const status = useLedgerStore((s) => s.status)
  const accounts = useLedgerStore((s) => s.accounts)
  const loadAccounts = useLedgerStore((s) => s.loadAccounts)
  const [submitting, setSubmitting] = useState(false)
  const postings = Form.useWatch('postings', form)

  useEffect(() => {
    void loadAccounts()
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

  const accountOptions = accounts.map((a) => ({ value: a }))
  const currencyOptions = (status?.operatingCurrency ?? []).map((c) => ({ value: c }))

  const numberRule = (fieldName: number): Rule => ({
    validator: (_rule, value: string | undefined | null) => {
      const lastIdx = (postings?.length ?? 0) - 1
      const empty = value === undefined || value === null || value === ''
      if (fieldName === lastIdx && empty) {
        return Promise.resolve() // 末行留空：自动平衡补差
      }
      if (empty) return Promise.reject(new Error('请输入金额'))
      if (!DECIMAL_RE.test(value)) return Promise.reject(new Error('金额格式非法'))
      return Promise.resolve()
    }
  })

  const handleFinish = async (values: EntryFormValues) => {
    const params: AddEntryParams = {
      date: (values.date ?? dayjs()).format('YYYY-MM-DD'),
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

  return (
    <ProForm<EntryFormValues>
      form={form}
      onFinish={handleFinish}
      initialValues={{ date: dayjs(), flag: '*', postings: [{}, {}] }}
      submitter={{
        searchConfig: { submitText: '写入账本' },
        submitButtonProps: { loading: submitting }
      }}
      style={{ maxWidth: 720 }}
    >
      <ProFormDatePicker name="date" label="日期" fieldProps={{ format: 'YYYY-MM-DD' }} />
      <ProFormRadio.Group
        name="flag"
        label="标志"
        options={[
          { label: '* 已确认', value: '*' },
          { label: '! 未确认', value: '!' }
        ]}
      />
      <ProFormText name="payee" label="Payee" fieldProps={{ maxLength: 200 }} />
      <ProFormText name="narration" label="Narration" fieldProps={{ maxLength: 200 }} />

      <Form.List
        name="postings"
        rules={[
          {
            validator: async (_rule, rows: PostingRow[] | undefined) => {
              if (!rows || rows.length < 2) throw new Error('至少需要 2 行记账行')
            }
          }
        ]}
      >
        {(fields, { add, remove }) => (
          <>
            {fields.map((field) => (
              <div key={field.key} style={{ display: 'flex', gap: 8 }}>
                <Form.Item
                  name={[field.name, 'account']}
                  style={{ flex: 3, marginBottom: 12 }}
                  rules={[
                    { required: true, message: '请输入账户' },
                    { pattern: /^[A-Z]\S*:\S*$/, message: '账户须大写字母开头、含冒号、无空格' }
                  ]}
                >
                  <AutoComplete options={accountOptions} placeholder="账户，如 Expenses:Food" />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'number']}
                  style={{ flex: 2, marginBottom: 12 }}
                  rules={[numberRule(field.name)]}
                >
                  <InputNumber stringMode precision={4} placeholder="金额" style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'currency']}
                  style={{ flex: 1, marginBottom: 12 }}
                  rules={[{ required: true, message: '请输入货币' }]}
                >
                  <AutoComplete options={currencyOptions} placeholder="货币，如 CNY" />
                </Form.Item>
                {fields.length > 2 && (
                  <Button
                    type="text"
                    danger
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(field.name)}
                    aria-label="删除记账行"
                  />
                )}
              </div>
            ))}
            <Form.Item style={{ marginBottom: 12 }}>
              <Button
                type="dashed"
                block
                icon={<PlusOutlined />}
                onClick={() => add({})}
                disabled={fields.length >= MAX_POSTINGS}
              >
                添加记账行
              </Button>
            </Form.Item>
          </>
        )}
      </Form.List>
    </ProForm>
  )
}

/**
 * 自动平衡决策（纯函数，单测覆盖）：
 * 行数 ≥2 且末行金额为空 → 前 n-1 行非空金额之和取反（始终返回，含 '0'）；
 * 末行非空（用户正在输入/已填）或行数不足 → undefined（不动）。
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
  try {
    return computeBalancingNumber(amounts)
  } catch {
    return undefined // 非法输入：交给表单校验提示，不在输入时抛错
  }
}
