/**
 * 分录行卡（重设计）：账户为主输入（占主体宽度），金额 + 货币为副输入组（右侧 240px）；
 * 行头为「借方/贷方」语义标签 + 账户类型决定的余额变动方向（资金增加/收入增加…）。
 * 方向不按行序硬编码，而由账户类型推导（见 postingDirection.ts）——账户填在哪一行都记对。
 * 金额框的符号只体现在显示上（displaySignedNumber），表单存值仍是用户输入的数值。
 * label「账户/金额/货币」为 e2e getByLabel 依赖，不得改名。
 */
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons'
import { AutoComplete, Form, InputNumber, Select } from 'antd'
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
  index: 0 | 1
  /** 该行记账符号（由账户类型推导，两行互为相反数） */
  sign: PostingSign
  /** 该行记账语义（如「收入增加」），随所选账户动态变化 */
  effectLabel: string
  /** 金额只读（第二行自动平衡，不可手动编辑） */
  amountReadOnly?: boolean
  currencyOptions: CurrencyOption[]
  accountOptions: AccountOption[]
  accountRules: Rule[]
  numberRules: Rule[]
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
  currencyOptions,
  accountOptions,
  accountRules,
  numberRules
}: Props) {
  const meta = DIRECTION_META[sign]
  return (
    <div className={`posting-row posting-row--${meta.tone}`}>
      <div className="posting-row__head">
        {meta.icon}
        <span className="posting-row__head-tag">{meta.tag}</span>
        <span className="posting-row__head-text">{effectLabel}</span>
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
              formatter={(value) => displaySignedNumber(value, sign)}
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
    </div>
  )
}
