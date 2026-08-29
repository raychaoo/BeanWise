/**
 * 分录行借贷卡（批次 B Task 3，方案模块 3 骨架）：上行蓝边「资金减少/支出方」，下行橙边「资金增加/收入方」。
 * 纯展示组件：name/rules 仍由父级（EntryFormView 的 Form.List）传入——写路径与校验逻辑零改动；
 * 账户下拉 options 为五大类分组（groupAccountOptions），金额 stringMode 十进制字符串直取。
 * label「账户/金额/货币」为 e2e getByLabel 依赖，不得改名。
 */
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons'
import { AutoComplete, Form, InputNumber, Select } from 'antd'
import type { Rule } from 'antd/es/form'
import type { AccountOption } from '../../stores/ledger'
import { groupAccountOptions } from '../../utils/accountGroup'

interface CurrencyOption {
  value: string
}

interface Props {
  index: 0 | 1
  currencyOptions: CurrencyOption[]
  /** 已按互斥语义过滤后的当行账户选项（filterAccountOptions，父级计算） */
  accountOptions: AccountOption[]
  accountRules: Rule[]
  numberRules: Rule[]
}

const ROW_META = [
  {
    tone: 'debit',
    icon: <ArrowUpOutlined />,
    head: '资金减少 / 支出方',
    accountPlaceholder: '选择资金减少/支出账户'
  },
  {
    tone: 'credit',
    icon: <ArrowDownOutlined />,
    head: '资金增加 / 收入方',
    accountPlaceholder: '选择资金增加/收入账户'
  }
] as const

export default function PostingRowCard({ index, currencyOptions, accountOptions, accountRules, numberRules }: Props) {
  const meta = ROW_META[index]
  return (
    <div className={`posting-row posting-row--${meta.tone}`}>
      <div className="posting-row__head">
        {meta.icon}
        <span>{meta.head}</span>
      </div>
      <div className="posting-row__fields">
        <Form.Item className="posting-row__account" name={[index, 'account']} label="账户" rules={accountRules}>
          <Select
            showSearch
            optionFilterProp="label"
            options={groupAccountOptions(accountOptions)}
            placeholder={meta.accountPlaceholder}
          />
        </Form.Item>
        <Form.Item className="posting-row__number" name={[index, 'number']} label="金额" rules={numberRules}>
          {/* stringMode 直取十进制字符串；不设 precision——antd 在 stringMode 下会重格式化
              数值（如 '0' → '0.0000'），破坏金额原样传递（校验以正则为准） */}
          <InputNumber stringMode placeholder="0.00" style={{ width: '100%' }} controls={false} />
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
  )
}
