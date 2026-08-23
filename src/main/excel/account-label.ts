/**
 * Excel 导入账户显示名与账户库同步（M10）。
 * 新账户路径在导入后自动补进 accounts.json；显示名由模板映射键反查生成（反查不到用
 * 中文路径兜底），描述按账户在映射中的角色生成（支出/收入/来源/兜底 + 模板名）。
 * 已存在账户不覆盖用户自定义名称与描述。
 */
import type { AccountEntry, ExcelImportTemplate } from '../../shared/ipc'
import { toChineseAccountLabel } from '../account-path-label'

export interface ExcelAccountStore {
  load(): AccountEntry[]
  save(accounts: AccountEntry[]): void
  nextId(): number
}

/** 按模板映射反查账户中文显示名；找不到时用中文路径兜底。 */
export function excelAccountLabel(account: string, template: ExcelImportTemplate): string {
  const cfg = template.accountMapping
  for (const [label, value] of Object.entries(cfg.expenseByType)) {
    if (value === account) return label === '其他' ? '其他支出' : label
  }
  for (const [label, value] of Object.entries(cfg.incomeByType)) {
    if (value === account) {
      if (label.includes('退款') || label === '二维码收款' || label === '其他') {
        return label === '其他' ? '其他收入' : label
      }
      return `${label}收入`
    }
  }
  for (const [label, value] of Object.entries(cfg.sourceByMethod)) {
    if (value === account) return label === '零钱' ? '微信余额' : label
  }
  for (const [label, value] of Object.entries(cfg.cashAccountByMethod)) {
    if (value === account) return label === '零钱' ? '微信余额' : label
  }
  if (cfg.fallbackExpenseAccount === account) return '未分类支出'
  if (cfg.fallbackIncomeAccount === account) return '其他收入'
  if (cfg.fallbackSourceAccount === account || cfg.fallbackCashAccount === account) return '未分类资产'
  return toChineseAccountLabel(account)
}

/** 按账户在模板映射中的角色生成用途描述，如「支付渠道来源账户 · 招商银行信用卡」。 */
export function excelAccountDescription(account: string, template: ExcelImportTemplate): string {
  const cfg = template.accountMapping
  let role: string
  if (Object.values(cfg.expenseByType).includes(account)) role = '支出科目'
  else if (Object.values(cfg.incomeByType).includes(account)) role = '收入科目'
  else if (Object.values(cfg.sourceByMethod).includes(account)) role = '支付渠道来源账户'
  else if (Object.values(cfg.cashAccountByMethod).includes(account)) role = '提现/充值目标账户'
  else if (cfg.fallbackExpenseAccount === account || cfg.fallbackIncomeAccount === account) role = '未分类收支兜底'
  else if (cfg.fallbackSourceAccount === account || cfg.fallbackCashAccount === account) role = '未分类资产兜底'
  else role = '流水导入'
  const templateName = template.name?.trim() || 'Excel 流水'
  return `${role} · ${templateName}`
}

/** 把账户库中缺失的账户补进去，返回新增条目。 */
export function syncExcelAccountsToConfig(
  accountsUsed: readonly string[],
  template: ExcelImportTemplate,
  store: ExcelAccountStore
): AccountEntry[] {
  const existing = store.load()
  const existingValues = new Set(existing.map((e) => e.value))
  const missing = [...new Set(accountsUsed)].filter((value) => !existingValues.has(value))
  if (missing.length === 0) return []

  let nextId = store.nextId()
  const additions: AccountEntry[] = missing.map((value) => ({
    id: nextId++,
    name: excelAccountLabel(value, template),
    value,
    description: excelAccountDescription(value, template)
  }))
  store.save([...existing, ...additions])
  return additions
}
