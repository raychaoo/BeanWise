/**
 * Excel 导入模板的结构化校验/规范化（从 ipc-handlers-excel.ts 抽出，M11 同步并入账户库一起提交）。
 *
 * 抽出的动机有两个：
 * 1. 纯函数、无 IO——同步合并引擎（core/merge-engine.ts）需要在落盘前用它校验合并结果；
 * 2. `normalizeTemplate({ ...t, id: '' })` 是模板的**规范形式**（逐字段白名单构造、键序固定），
 *    合并时用它做「同 source 两侧内容是否一致」的比较基准。
 */
import type {
  AccountMappingConfig,
  ExcelDirectionMode,
  ExcelFieldMapping,
  ExcelImportTemplate
} from '../../shared/ipc'
import { defaultAccountMapping } from './account-mapping'

const ACCOUNT_RE = /^[A-Z]\S*:\S*$/
const DIRECTION_MODES: ExcelDirectionMode[] = ['column', 'amountSign', 'keywords']

export function validAccount(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ACCOUNT_RE.test(value.trim()) || value.trim().length > 200) {
    throw new Error(`${label} 必须是合法 Beancount 账户路径`)
  }
  return value.trim()
}

/** 账户映射：合并默认四表 + 兜底，逐值校验。 */
export function normalizeAccountMapping(raw: unknown): AccountMappingConfig {
  const c = (raw ?? {}) as Partial<AccountMappingConfig>
  const d = defaultAccountMapping()
  const dict = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('账户映射表必须为对象')
    return v as Record<string, string>
  }
  const expenseByType: Record<string, string> = {}
  for (const [k, v] of Object.entries(dict(c.expenseByType))) {
    if (k.trim()) expenseByType[k.trim()] = validAccount(v, `支出账户 ${k}`)
  }
  const incomeByType: Record<string, string> = {}
  for (const [k, v] of Object.entries(dict(c.incomeByType ?? d.incomeByType))) {
    if (k.trim()) incomeByType[k.trim()] = validAccount(v, `收入账户 ${k}`)
  }
  const sourceByMethod: Record<string, string> = {}
  for (const [k, v] of Object.entries(dict(c.sourceByMethod))) {
    if (k.trim()) sourceByMethod[k.trim()] = validAccount(v, `来源账户 ${k}`)
  }
  const cashAccountByMethod: Record<string, string> = {}
  for (const [k, v] of Object.entries(dict(c.cashAccountByMethod ?? d.cashAccountByMethod))) {
    if (k.trim()) cashAccountByMethod[k.trim()] = validAccount(v, `现金账户 ${k}`)
  }
  return {
    expenseByType,
    incomeByType,
    sourceByMethod,
    cashAccountByMethod,
    fallbackExpenseAccount: validAccount(c.fallbackExpenseAccount || d.fallbackExpenseAccount, '兜底支出账户'),
    fallbackSourceAccount: validAccount(c.fallbackSourceAccount || d.fallbackSourceAccount, '兜底来源账户'),
    fallbackIncomeAccount: validAccount(c.fallbackIncomeAccount || d.fallbackIncomeAccount, '兜底收入账户'),
    fallbackCashAccount: validAccount(c.fallbackCashAccount || d.fallbackCashAccount, '兜底现金账户')
  }
}

export function validFieldName(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (value.trim().length > 100) throw new Error(`${label} 列名过长`)
  return value.trim()
}

export function normalizeFieldMapping(raw: unknown): ExcelFieldMapping {
  const f = (raw ?? {}) as Partial<ExcelFieldMapping>
  const mapping: ExcelFieldMapping = {
    dateColumn: validFieldName(f.dateColumn, '日期列'),
    amountColumn: validFieldName(f.amountColumn, '金额列'),
    ioColumn: validFieldName(f.ioColumn, '方向列'),
    typeColumn: validFieldName(f.typeColumn, '交易类型列'),
    counterpartyColumn: validFieldName(f.counterpartyColumn, '交易对方列'),
    productColumn: validFieldName(f.productColumn, '商品/摘要列'),
    methodColumn: validFieldName(f.methodColumn, '支付方式列'),
    statusColumn: validFieldName(f.statusColumn, '状态列'),
    rowIdColumn: validFieldName(f.rowIdColumn, '单号列'),
    noteColumn: validFieldName(f.noteColumn, '备注列')
  }
  if (!mapping.dateColumn) throw new Error('请指定日期列')
  if (!mapping.amountColumn) throw new Error('请指定金额列')
  return mapping
}

export function normalizeDirectionRule(raw: unknown): ExcelImportTemplate['directionRule'] {
  const r = (raw ?? {}) as Partial<ExcelImportTemplate['directionRule']>
  if (!r.mode || !DIRECTION_MODES.includes(r.mode)) throw new Error('方向规则 mode 非法')
  const neutralKeywords = Array.isArray(r.neutralKeywords)
    ? [...new Set(r.neutralKeywords.map((k) => (typeof k === 'string' ? k.trim() : '')).filter((k) => k !== ''))]
    : []
  const rule: ExcelImportTemplate['directionRule'] = { mode: r.mode, neutralKeywords }
  if (r.mode === 'amountSign' && (r.positiveAs !== 'income' && r.positiveAs !== 'expense')) {
    throw new Error('金额正负方向规则需指定 positiveAs')
  }
  if (r.mode === 'keywords' && r.defaultKind !== 'income' && r.defaultKind !== 'expense') {
    throw new Error('关键词方向规则需指定 defaultKind')
  }
  if (r.mode === 'amountSign' && r.positiveAs) rule.positiveAs = r.positiveAs
  if (r.mode === 'keywords' && r.defaultKind) rule.defaultKind = r.defaultKind
  return rule
}

export function normalizeTemplate(raw: unknown): ExcelImportTemplate {
  const t = (raw ?? {}) as Partial<ExcelImportTemplate>
  if (typeof t.name !== 'string' || t.name.trim() === '' || t.name.trim().length > 50) {
    throw new Error('模板名称必填且不超过 50 字符')
  }
  let source = typeof t.source === 'string' ? t.source.trim() : ''
  if (source === '' && typeof t.id === 'string' && t.id.trim() !== '') source = t.id.trim()
  if (source === '') throw new Error('模板 source 必填（去重标识）')
  if (/\s/.test(source)) throw new Error('模板 source 不能包含空白')
  if (source.length > 50) throw new Error('模板 source 过长')

  let headerRow: number | undefined
  if (t.headerRow !== undefined && t.headerRow !== null && t.headerRow !== 0) {
    if (typeof t.headerRow !== 'number' || !Number.isInteger(t.headerRow) || t.headerRow < 1) {
      throw new Error('表头行必须是正整数')
    }
    headerRow = t.headerRow
  }
  const sheetName = typeof t.sheetName === 'string' && t.sheetName.trim() !== '' ? t.sheetName.trim() : undefined
  if (sheetName && sheetName.length > 100) throw new Error('工作表名过长')

  return {
    id: typeof t.id === 'string' && t.id.trim() !== '' ? t.id.trim() : '',
    name: t.name.trim(),
    source,
    ...(headerRow !== undefined ? { headerRow } : {}),
    ...(sheetName !== undefined ? { sheetName } : {}),
    fieldMapping: normalizeFieldMapping(t.fieldMapping),
    directionRule: normalizeDirectionRule(t.directionRule),
    accountMapping: normalizeAccountMapping(t.accountMapping),
    strictNewAccounts: t.strictNewAccounts === true
  }
}

/**
 * 模板数组整体规范化（合并落盘 / 文件解析用）。
 * 按 source 去重（同 source 保留 id 字典序靠前者，保证确定性）——`excel:save-template`
 * 只校验 id 唯一、不校验 source 唯一，本地可能已存在同 source 双模板，这里收敛掉。
 */
export function normalizeTemplates(raw: unknown): ExcelImportTemplate[] {
  if (!Array.isArray(raw)) throw new Error('templates 必须为数组')
  const bySource = new Map<string, ExcelImportTemplate>()
  for (const item of raw) {
    const t = normalizeTemplate(item)
    const prev = bySource.get(t.source)
    if (!prev || t.id < prev.id) bySource.set(t.source, t)
  }
  return [...bySource.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
}
