/**
 * 可复用凭证表单：录入页与明细页编辑抽屉共用同一套分区布局、分录校验与账户联动逻辑。
 * 编辑模式保留账本原始金额符号，并把稳定 ID/link 作为不可见元数据原样提交。
 */
import { PlusOutlined } from '@ant-design/icons'
import { ProForm, ProFormDatePicker, ProFormRadio, ProFormText } from '@ant-design/pro-components'
import { Button, Form, message } from 'antd'
import type { FormInstance } from 'antd'
import type { Rule } from 'antd/es/form'
import { useEffect, useState } from 'react'
import type { AddEntryParams } from '../../../../shared/ipc'
import { accountType, filterAccountOptions, isAllPnlAccounts, isEntryAccountPairValid } from '../../../../shared/account'
import { useEntryFormStore } from '../../stores/entry-form'
import { useLedgerStore } from '../../stores/ledger'
import BalanceHint from './BalanceHint'
import PostingRowCard from './PostingRowCard'
import { formValuesToEntryParams, nextBalancingNumber } from './entryFormValues'
import type { EntryFormMeta, EntryFormValues, PostingRow } from './entryFormValues'
import { postingEffectLabel, resolvePostingSigns } from './postingDirection'
import type { PostingSign } from './postingDirection'

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

interface Props {
  form: FormInstance<EntryFormValues>
  mode: 'create' | 'edit'
  initialValues: EntryFormValues
  meta?: EntryFormMeta
  onSubmit: (params: AddEntryParams) => Promise<void>
}

export default function EntryForm({ form, mode, initialValues, meta, onSubmit }: Props) {
  const status = useLedgerStore((s) => s.status)
  const accountOptions = useLedgerStore((s) => s.accountOptions)
  const counterpartyValues = useLedgerStore((s) => s.counterpartyValues)
  const counterpartyOptions = useLedgerStore((s) => s.counterpartyOptions)
  const [submitting, setSubmitting] = useState(false)
  const postings = Form.useWatch('postings', form)
  const currencyOptions = (status?.operatingCurrency ?? []).map((c) => ({ value: c }))
  const defaultCurrency = status?.operatingCurrency?.[0] ?? 'CNY'

  useEffect(() => {
    form.setFieldsValue(initialValues)
  }, [form, initialValues])

  // 新增模式的两行录入保持原有自动平衡；编辑模式与多行拆分让用户显式调整金额。
  useEffect(() => {
    if (mode !== 'create' || !Array.isArray(postings) || postings.length !== 2) return
    const expected = nextBalancingNumber(postings)
    if (expected !== undefined && postings[1]?.number !== expected) {
      form.setFieldValue(['postings', 1, 'number'], expected)
    }
  }, [form, mode, postings])

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

  const numberRule = (fieldName: number): Rule => ({
    validator: (_rule, value: string | undefined | null) => {
      const lastIdx = (postings?.length ?? 0) - 1
      const empty = value === undefined || value === null || value === ''
      if (mode === 'create' && postings?.length === 2 && fieldName === lastIdx && empty) return Promise.resolve()
      if (empty) return Promise.reject(new Error('请输入金额'))
      if (!DECIMAL_RE.test(value)) return Promise.reject(new Error('金额格式非法'))
      return Promise.resolve()
    }
  })

  const accountRules: Rule[] = [
    { required: true, message: '请输入账户' },
    { pattern: /^[A-Z]\S*:\S*$/, message: '账户须大写字母开头、含冒号、无空格' }
  ]

  const accountOptionsFor = (rowIndex: number) => {
    const otherAccount = (postings ?? [])
      .map((row, index) => (index === rowIndex ? undefined : row?.account?.trim()))
      .find((account) => !!account)
    return filterAccountOptions(accountOptions, otherAccount)
  }

  const signForRow = (row: PostingRow | undefined, index: number): PostingSign => {
    if (mode === 'edit' || (postings?.length ?? 0) > 2) {
      const number = row?.number?.trim()
      if (number) return number.startsWith('-') ? -1 : 1
      if (accountType(row?.account?.trim() ?? '') === 'Income') return -1
      if (accountType(row?.account?.trim() ?? '') === 'Expenses') return 1
      return index % 2 === 0 ? 1 : -1
    }
    const signs = resolvePostingSigns(postings?.[0]?.account, postings?.[1]?.account)
    return signs[index] ?? (index % 2 === 0 ? 1 : -1)
  }

  const handleFinish = async (values: EntryFormValues) => {
    setSubmitting(true)
    try {
      await onSubmit(
        formValuesToEntryParams(values, {
          ...meta,
          preserveSigns: mode === 'edit' || (values.postings?.length ?? 0) > 2
        })
      )
    } catch (err) {
      message.error(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ProForm<EntryFormValues>
      form={form}
      initialValues={initialValues}
      onFinish={handleFinish}
      onValuesChange={() => {
        if (mode === 'create') useEntryFormStore.getState().setDirty(true)
      }}
      submitter={false}
    >
      <div className="entry-section">
        <div className="entry-form-meta">
          <ProFormDatePicker
            name="date"
            label="日期"
            fieldProps={{
              format: 'YYYY-MM-DD HH:mm:ss',
              showTime: { format: 'HH:mm:ss' },
              allowClear: false,
              style: { width: '100%' }
            }}
          />
          <ProFormRadio.Group
            name="flag"
            label="标志"
            options={[
              { label: '* 已确认', value: '*' },
              { label: '! 未确认', value: '!' }
            ]}
          />
        </div>
        <div className="entry-form-text">
          <ProFormText name="payee" label="交易对象" fieldProps={{ maxLength: 200 }} />
          <ProFormText name="narration" label="说明" fieldProps={{ maxLength: 200 }} />
        </div>
      </div>

      <div className="entry-section">
        <span className="entry-section__title">记账行</span>
        {mode === 'create' && (
          <p className="entry-postings-tip">
            两行分别记录资金涉及的两个账户；需要拆分时添加分录。金额方向由账户类型自动判定，第二行自动取反。
          </p>
        )}

        <Form.List
          name="postings"
          rules={[
            {
              validator: async (_rule, rows: PostingRow[] | undefined) => {
                if (!rows || rows.length < 2) throw new Error('记账行至少需要两行')
                if (rows.length > 20) throw new Error('记账行不能超过 20 行')
                const accounts = rows.map((r) => r?.account?.trim()).filter((v): v is string => !!v)
                if (accounts.length === rows.length) {
                  if (rows.length === 2 && !isEntryAccountPairValid(accounts[0]!, accounts[1]!)) {
                    throw new Error('两行不能同为收支账户，至少一边应为资产/负债/权益账户')
                  }
                  if (rows.length > 2 && isAllPnlAccounts(accounts)) {
                    throw new Error('交易不能全部为收支账户，至少一边应为资产/负债/权益账户')
                  }
                }
              }
            }
          ]}
        >
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => {
                const row = postings?.[field.name]
                const sign = signForRow(row, field.name)
                return (
                  <PostingRowCard
                    key={field.key}
                    index={field.name}
                    sign={sign}
                    effectLabel={postingEffectLabel(row?.account, sign)}
                    amountReadOnly={mode === 'create' && fields.length === 2 && field.name === 1}
                    preserveSign={mode === 'edit' || fields.length > 2}
                    removable={fields.length > 2}
                    onRemove={() => remove(field.name)}
                    currencyOptions={currencyOptions}
                    accountOptions={accountOptionsFor(field.name)}
                    accountRules={accountRules}
                    numberRules={[numberRule(field.name)]}
                    counterpartyEnabled={counterpartyValues.includes((row?.account ?? '').trim())}
                    counterpartyOptions={counterpartyOptions}
                  />
                )
              })}
              <Button
                type="dashed"
                block
                icon={<PlusOutlined />}
                disabled={fields.length >= 20}
                onClick={() => add({ currency: defaultCurrency })}
              >
                添加分录
              </Button>
            </>
          )}
        </Form.List>
        <BalanceHint rows={postings} />
      </div>

      <div className="entry-section">
        <div className="entry-submit-bar">
          <Button type="primary" loading={submitting} onClick={() => form.submit()}>
            {mode === 'edit' ? '保存修改' : '写入账本'}
          </Button>
          <span className="entry-submit-tip">{mode === 'edit' ? '按 ID 更新并校验' : 'Ctrl + Enter 快速提交'}</span>
        </div>
      </div>
    </ProForm>
  )
}
