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
import AiEntryPanel from './AiEntryPanel'

const MAX_POSTINGS = 20
const DECIMAL_RE = /^-?\d+(\.\d+)?$/

interface PostingRow {
  account?: string
  number?: string | null
  currency?: string
}

interface Props {
  /** AI 区块「去设置」/未配置引导 → 打开 AI 设置 Modal（App.tsx 持有状态） */
  onOpenAiSettings: () => void
}

interface EntryFormValues {
  /** ProFormDatePicker 设 format 后 onFinish 提交值为 YYYY-MM-DD 字符串；填表路径可能为 dayjs */
  date?: string | dayjs.Dayjs
  flag?: '*' | '!'
  payee?: string
  narration?: string
  postings: PostingRow[]
}

export default function EntryFormView({ onOpenAiSettings }: Props) {
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

  /** 草稿 → 表单回填（写路径唯一：确认仍走本表单的「写入账本」提交） */
  const handleFillForm = (draft: AddEntryParams) => {
    form.setFieldsValue(draftToFormValues(draft))
    message.success('已填入表单，请确认后提交')
  }

  return (
    <>
      <AiEntryPanel onOpenSettings={onOpenAiSettings} onFillForm={handleFillForm} />
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
                    label="账户"
                    style={{ flex: 3, marginBottom: 12 }}
                    rules={[
                      { required: true, message: '请输入账户' },
                      { pattern: /^[A-Z]\S*:\S*$/, message: '账户须大写字母开头、含冒号、无空格' }
                    ]}
                  >
                    <AutoComplete options={accountOptions} placeholder="如 Expenses:Food" />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'number']}
                    label="金额"
                    style={{ flex: 2, marginBottom: 12 }}
                    rules={[numberRule(field.name)]}
                  >
                    {/* stringMode 直取十进制字符串；不设 precision——antd 在 stringMode 下会重格式化
                        数值（如 '0' → '0.0000'），破坏金额原样传递（校验以正则为准） */}
                    <InputNumber stringMode placeholder="0.00" style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'currency']}
                    label="货币"
                    style={{ flex: 1, marginBottom: 12 }}
                    rules={[{ required: true, message: '请输入货币' }]}
                  >
                    <AutoComplete options={currencyOptions} placeholder="如 CNY" />
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
    </>
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
