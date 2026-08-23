/**
 * Beancount 账户路径 → 中文显示名兜底。
 * 当映射反查不到时使用（如手工新建的 Assets:Bank:ICBC），避免账户库出现纯英文路径。
 */
const SEGMENT_LABELS: Record<string, string> = {
  Assets: '资产',
  Liabilities: '负债',
  Equity: '权益',
  Income: '收入',
  Expenses: '支出',
  Bank: '银行',
  Cash: '现金',
  Card: '卡',
  CreditCard: '信用卡',
  Wallet: '钱包',
  Wechat: '微信',
  WeChat: '微信',
  Alipay: '支付宝',
  CMB: '招商银行',
  ICBC: '工商银行',
  CCB: '建设银行',
  ABC: '农业银行',
  BOC: '中国银行',
  CMBC: '民生银行',
  SPDB: '浦发银行',
  CIB: '兴业银行',
  CEB: '光大银行',
  CITIC: '中信银行',
  PAB: '平安银行',
  PSBC: '邮储银行',
  HXB: '华夏银行'
}

/** Assets:Bank:CCB → 资产·银行·建设银行；未知段保留原样，保证结果恒为可读文本。 */
export function toChineseAccountLabel(account: string): string {
  return account
    .split(':')
    .map((seg) => SEGMENT_LABELS[seg] ?? seg)
    .join('·')
}
