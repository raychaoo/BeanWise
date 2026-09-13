/**
 * 分录行卡（重设计）：账户为主输入（占主体宽度），金额 + 货币为副输入组（右侧 240px）；
 * 行头为「借方/贷方」语义标签 + 账户类型决定的余额变动方向（资金增加/收入增加…）。
 * 方向不按行序硬编码，而由账户类型推导（见 postingDirection.ts）——账户填在哪一行都记对。
 * 金额框的符号只体现在显示上（displaySignedNumber），表单存值仍是用户输入的数值。
 * 账户为往来类时（ADR 23）额外显示「往来对象」输入（历史值补全）——该对象随分录写入
 * posting 级 metadata，供往来账报表聚合；非往来类账户不显示，避免无谓字段干扰录入。
 * label「账户/金额/货币」为 e2e getByLabel 依赖，不得改名。
 */
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined } from '@ant-design/icons'
import { AutoComplete, Button, Form, InputNumber, Select } from 'antd'
import type { Rule } from 'antd/es/form'
import type { ReactNode } from 'react'
import type { AccountOption } from '../../stores/ledger'
import { groupAccountOptions } from '../../utils/accountGroup'
import { displaySignedNumber } from './postingDirection'
import type { PostingSign } from './postingDirection'

interface CurrencyOption {
  value: string
}

interface Props {
  index: number
  /** 该行记账符号（由账户类型推导，两行互为相反数） */
  sign: PostingSign
  /** 该行记账语义（如「收入增加」），随所选账户动态变化 */
  effectLabel: string
  /** 金额只读（第二行自动平衡，不可手动编辑） */
  amountReadOnly?: boolean
  /** 编辑/多行场景：金额已是最终符号，输入框原样呈现；仅用 sign 控制视觉方向。 */
  preserveSign?: boolean
  removable?: boolean
  onRemove?: () => void
  currencyOptions: CurrencyOption[]
  accountOptions: AccountOption[]
  accountRules: Rule[]
  numberRules: Rule[]
  /** 该行账户是往来类账户（ADR 23）→ 显示「往来对象」输入 */
  counterpartyEnabled?: boolean
  /** 往来对象历史候选（补全防手误分裂成两个对象） */
  counterpartyOptions?: string[]
}

const DIRECTION_META: Record<PostingSign, { tone: string; icon: ReactNode; tag: string; placeholder: string }> = {
  1: {
    tone: 'debit',
    icon: <ArrowUpOutlined />,
    tag: '借方',
    placeholder: '选择支出 / 转入账户'
  },
  [-1]: {
    tone: 'credit',
    icon: <ArrowDownOutlined />,
    tag: '贷方',
    placeholder: '选择收入 / 转出账户'
  }
}

export default function PostingRowCard({
  index,
  sign,
  effectLabel,
  amountReadOnly,
  preserveSign,
  removable,
  onRemove,
  currencyOptions,
  accountOptions,
  accountRules,
  numberRules,
  counterpartyEnabled,
  counterpartyOptions
}: Props) {
  const meta = DIRECTION_META[sign]
  return (
    <div className={`posting-row posting-row--${meta.tone}`}>
      <div className="posting-row__head">
        {meta.icon}
        <span className="posting-row__head-tag">{meta.tag}</span>
        <span className="posting-row__head-text">{effectLabel}</span>
        {removable && (
          <Button
            type="text"
            danger
            size="small"
            className="posting-row__remove"
            aria-label={`删除第 ${index + 1} 行`}
            icon={<DeleteOutlined />}
            onClick={onRemove}
          />
        )}
      </div>
      <div className="posting-row__fields">
        <Form.Item className="posting-row__account" name={[index, 'account']} label="账户" rules={accountRules}>
          <Select
            showSearch
            optionFilterProp="label"
            options={groupAccountOptions(accountOptions)}
            placeholder={meta.placeholder}
          />
        </Form.Item>
        <div className="posting-row__aside">
          <Form.Item className="posting-row__number" name={[index, 'number']} label="金额" rules={numberRules}>
            <InputNumber
              stringMode
              placeholder="0.00"
              controls={false}
              readOnly={amountReadOnly}
              formatter={(value) => (preserveSign ? String(value ?? '') : displaySignedNumber(value, sign))}
            />
          </Form.Item>
          <Form.Item
            className="posting-row__currency"
            name={[index, 'currency']}
            label="货币"
            rules={[{ required: true, message: '请输入货币' }]}
          >
            <AutoComplete options={currencyOptions} placeholder="如 CNY" />
          </Form.Item>
        </div>
      </div>
      {counterpartyEnabled && (
        <Form.Item
          className="posting-row__counterparty"
          name={[index, 'counterparty']}
          label="往来对象"
          tooltip="这一行记的是谁的钱（借给谁 / 谁还的）；往来账报表按此聚合"
        >
          <AutoComplete
            options={(counterpartyOptions ?? []).map((c) => ({ value: c }))}
            placeholder="如 李志全"
            allowClear
          />
        </Form.Item>
      )}
    </div>
  )
}
