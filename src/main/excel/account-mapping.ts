/**
 * 通用导入默认账户映射（Excel 流水导入用）。
 * 新建模板/未配置键时的种子默认：交易类型 → 支出/收入账户、支付方式 → 来源/现金账户 + 兜底；
 * 用户在账户映射弹窗中可全部覆盖，导入时 normalizeAccountMapping 只对缺失键并入本默认。
 */
import type { AccountMappingConfig } from '../../shared/ipc'

export function defaultAccountMapping(): AccountMappingConfig {
  return {
    expenseByType: {
      商户消费: 'Expenses:Shopping:Other',
      扫二维码付款: 'Expenses:Other',
      群收款: 'Expenses:Social:Other',
      转账: 'Expenses:Other',
      '微信红包（单发）': 'Expenses:Social:RedPacket',
      零钱提现: 'Expenses:Other',
      其他: 'Expenses:Other'
    },
    incomeByType: {
      转账: 'Income:Transfer',
      群收款: 'Income:Group',
      二维码收款: 'Income:QRCode',
      其他: 'Income:Other',
      '美团平台商户-退款': 'Income:Refund',
      '摩登电竞馆-退款': 'Income:Refund',
      '小拉出行-退款': 'Income:Refund',
      // 银行流水常见收入类型（工资/代发 → 工资；网联收款/银联入账 → 其他收入；利息 → 利息）
      代发工资: 'Income:Salary',
      代发款项: 'Income:Salary',
      工资: 'Income:Salary',
      网联收款: 'Income:Other',
      银联入账: 'Income:Other',
      利息: 'Income:Interest'
    },
    sourceByMethod: {
      零钱: 'Assets:WeChat:Pay', // 微信零钱 → 微信余额-资产
      余额: 'Assets:Alipay:Balance', // 支付宝余额 → 支付宝余额-资产
      '招商银行储蓄卡(6156)': 'Assets:Bank:ZSYH'
    },
    cashAccountByMethod: {
      零钱: 'Assets:WeChat:Pay',
      余额: 'Assets:Alipay:Balance',
      '招商银行储蓄卡(6156)': 'Assets:Bank:ZSYH'
    },
    fallbackExpenseAccount: 'Expenses:Other',
    fallbackSourceAccount: 'Assets:WeChat',
    fallbackIncomeAccount: 'Income:Other',
    fallbackCashAccount: 'Assets:WeChat'
  }
}
