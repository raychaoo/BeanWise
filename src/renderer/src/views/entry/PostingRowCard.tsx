/**
 * 分录行卡（重设计）：账户为主输入（占主体宽度），金额 + 货币为副输入组（右侧 240px）；
 * 行头强化为「贷/付」「借/收」语义标签 + 辅助说明。纯展示组件：name/rules 仍由父级传入。
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
  /** 金额只读（第二行自动平衡，不可手动编辑） */
  amountReadOnly?: boolean
  currencyOptions: CurrencyOption[]
  accountOptions: AccountOption[]
  accountRules: Rule[]
  numberRules: Rule[]
}

const ROW_META = [
  {
    tone: 'debit',
    icon: <ArrowUpOutlined />,
    tag: '贷 / 付',
    head: '资金减少 / 支出方',
    accountPlaceholder: '选择资金减少/支出账户'
  },
  {
    tone: 'credit',
    icon: <ArrowDownOutlined />,
    tag: '借 / 收',
    head: '资金增加 / 收入方',
    accountPlaceholder: '选择资金增加/收入账户'
  }
] as const

export default function PostingRowCard({ index, amountReadOnly, currencyOptions, accountOptions, accountRules, numberRules }: Props) {
  const meta = ROW_META[index]
  return (
    <div className={`posting-row posting-row--${meta.tone}`}>
      <div className="posting-row__head">
        {meta.icon}
        <span className="posting-row__head-tag">{meta.tag}</span>
        <span className="posting-row__head-text">{meta.head}</span>
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
        <div className="posting-row__aside">
          <Form.Item className="posting-row__number" name={[index, 'number']} label="金额" rules={numberRules}>
            <InputNumber stringMode placeholder="0.00" controls={false} readOnly={amountReadOnly} />
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
