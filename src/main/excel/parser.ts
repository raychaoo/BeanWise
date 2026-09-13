/**
 * 通用 Excel 流水解析（M10）。
 *
 * 读取任意 xlsx / csv（UTF-8 / UTF-8 BOM / GBK 编码），经「列映射 → 方向判定 → 账户映射」
 * 归一化为标准预览行；账户映射按「交易类型/支付方式 → 账户」四表 + 兜底解析，
 * 去重标记使用 beanwise-import 标记，落盘链路见 ipc-handlers-excel。
 *
 * 纯函数可单测：readGrid 是唯一文件 IO 入口，applyTemplate / detectNewAccounts /
 * suggestFieldMapping / parseCsv / decodeCsvBuffer 等均不触碰文件系统。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import type {
  AccountEntry,
  ExcelDirectionRule,
  ExcelFieldMapping,
  ExcelImportTemplate,
  ExcelNewAccountInfo,
  ExcelNewTypeInfo,
  ExcelPreviewRow,
  ExcelPreviewTotals,
  AccountMappingConfig
} from '../../shared/ipc'
import { addDecimalStrings } from '../../shared/decimal'
import { computeDedupFingerprint } from '../core/dedup'
import { methodMapKey, typeMapKey } from '../../shared/import-keys'

export const BEANWISE_IMPORT_MARKER = 'beanwise-import'
const MAX_ROWS = 50_000
const MAX_COLS = 200

const FIELD_KEYS = [
  'dateColumn', 'amountColumn', 'ioColumn', 'typeColumn', 'counterpartyColumn',
  'productColumn', 'methodColumn', 'statusColumn', 'rowIdColumn', 'noteColumn'
] as const

const FIELD_KEYWORDS: Record<(typeof FIELD_KEYS)[number], string[]> = {
  dateColumn: ['交易时间', '交易日期', '日期', '时间', 'date', 'time', 'transaction date'],
  amountColumn: ['金额(元)', '金额', '交易金额', '发生额', 'amount', 'amt'],
  ioColumn: ['收/支', '收支', '收付', '方向', '借贷', 'income/expense', 'io', '收', '支'],
  typeColumn: ['交易类型', '交易分类', '类型', '业务类型', '交易摘要', 'type', 'category'],
  counterpartyColumn: ['交易对方', '对方名称', '对方', '商户名称', '商户', '收款方', '付款方', '对手信息', 'counterparty', 'merchant', 'payee'],
  productColumn: ['商品', '商品名称', '摘要', '交易说明', '说明', '用途', 'narration', 'memo', 'description', 'product'],
  methodColumn: ['支付方式', '付款方式', '交易账户', '付款账户', '来源账户', '账户', '卡号', '支付渠道', '交易渠道', 'method', 'account', 'card'],
  statusColumn: ['当前状态', '交易状态', '状态', 'status'],
  rowIdColumn: ['交易单号', '商户单号', '订单号', '流水号', '交易号', '订单编号', '流水', '序号', 'transaction id', 'order id'],
  noteColumn: ['备注', 'note', 'remark']
}

export interface ExcelGrid {
  sheets: string[]
  grid: string[][]
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** ExcelJS 单元格值 → 文本（日期按 UTC 分量取墙钟时间）。 */
function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return (
      `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())} ` +
      `${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}:${pad2(value.getUTCSeconds())}`
    )
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.result === 'string') return obj.result.trim()
    if (typeof obj.text === 'string') return obj.text.trim()
  }
  return ''
}

/** 标准 CSV 解析（支持引号内逗号/换行/双引号转义）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (row.length > 0 || field !== '') rows.push(row)
  return rows
}

/** CSV 编码探测与解码：BOM 优先，其次 UTF-8，含替换符则回退 GBK。 */
export function decodeCsvBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2))
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2))
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  if (!utf8.includes('\uFFFD')) return utf8
  return new TextDecoder('gbk').decode(buf)
}

/** 读取 Excel/Csv 为字符串网格（唯一文件 IO 入口）。 */
export async function readGrid(filePath: string, sheetName?: string): Promise<ExcelGrid> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.xlsx') return readXlsxGrid(filePath, sheetName)
  if (ext === '.xls') return readXlsGrid(filePath, sheetName)
  if (ext === '.csv' || ext === '.txt') return readCsvGrid(filePath)
  if (ext === '.pdf') {
    // 动态加载 pdfjs-dist，避免拖慢主进程启动与首屏
    const { readPdfGrid } = await import('./pdf')
    const grid = await readPdfGrid(filePath)
    return { sheets: ['PDF'], grid }
  }
  throw new Error('仅支持 .xlsx / .xls / .csv / .pdf 文件')
}

async function readXlsxGrid(filePath: string, sheetName?: string): Promise<ExcelGrid> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheets = workbook.worksheets.map((ws) => ws.name)
  const ws = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]
  if (!ws) throw new Error(`工作表不存在：${sheetName}`)
  const grid: string[][] = []
  const maxRow = Math.min(ws.rowCount, MAX_ROWS)
  const maxCol = Math.min(ws.columnCount, MAX_COLS)
  for (let r = 1; r <= maxRow; r++) {
    const row: string[] = []
    for (let c = 1; c <= maxCol; c++) {
      row.push(cellToText(ws.getRow(r).getCell(c).value))
    }
    grid.push(row)
  }
  return { sheets, grid }
}

/** 旧版 .xls（BIFF）读取：SheetJS 解析，按格式化文本输出（raw:false 保留日期/数字格式）。 */
function readXlsGrid(filePath: string, sheetName?: string): ExcelGrid {
  const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' })
  const sheets = workbook.SheetNames
  const ws = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[sheets[0]]
  if (!ws) throw new Error(`工作表不存在：${sheetName}`)
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' })
  const grid = rows
    .slice(0, MAX_ROWS)
    .map((row) => (row as unknown[]).slice(0, MAX_COLS).map((c) => (c === null || c === undefined ? '' : String(c))))
  return { sheets, grid }
}
function readCsvGrid(filePath: string): ExcelGrid {
  const buf = readFileSync(filePath)
  const text = decodeCsvBuffer(buf)
  const grid = parseCsv(text).map((row) => row.map((c) => c.trim()))
  return { sheets: ['Sheet1'], grid }
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s()（）/\\[\]【】]/g, '')
}

/** 表头单元格对某标准字段的匹配分（0 = 不匹配）。 */
export function fieldScore(text: string, field: (typeof FIELD_KEYS)[number]): number {
  const t = normalizeForMatch(text)
  if (!t) return 0
  let best = 0
  for (const kw of FIELD_KEYWORDS[field]) {
    const k = normalizeForMatch(kw)
    if (!k) continue
    if (k === t) best = Math.max(best, 10)
    else if (t.includes(k)) best = Math.max(best, k.length >= 4 ? 6 : 4)
    else if (k.includes(t) && t.length >= 2) best = Math.max(best, 3)
  }
  return best
}

/** 自动检测表头行（0 基索引；找不到返回 -1）。 */
export function detectHeaderRow(grid: string[][], limit = 30): number {
  for (let r = 0; r < Math.min(grid.length, limit); r++) {
    const cells = grid[r]
    let dateScore = 0
    let amountScore = 0
    let hits = 0
    for (const c of cells) {
      dateScore = Math.max(dateScore, fieldScore(c, 'dateColumn'))
      amountScore = Math.max(amountScore, fieldScore(c, 'amountColumn'))
      if (FIELD_KEYS.some((f) => fieldScore(c, f) >= 3)) hits++
    }
    if (dateScore >= 3 && amountScore >= 3 && hits >= 2) return r
  }
  return -1
}

/** 按表头单元格给出列映射建议（唯一分配，低分不分配）。 */
export function suggestFieldMapping(headerCells: string[]): ExcelFieldMapping {
  const used = new Set<number>()
  const pick = (field: (typeof FIELD_KEYS)[number]): string | undefined => {
    let bestIdx = -1
    let bestScore = 0
    headerCells.forEach((c, i) => {
      if (used.has(i)) return
      const s = fieldScore(c, field)
      if (s > bestScore) {
        bestScore = s
        bestIdx = i
      }
    })
    if (bestIdx === -1 || bestScore < 3) return undefined
    used.add(bestIdx)
    return headerCells[bestIdx]
  }
  return {
    dateColumn: pick('dateColumn'),
    amountColumn: pick('amountColumn'),
    ioColumn: pick('ioColumn'),
    typeColumn: pick('typeColumn'),
    counterpartyColumn: pick('counterpartyColumn'),
    productColumn: pick('productColumn'),
    methodColumn: pick('methodColumn'),
    statusColumn: pick('statusColumn'),
    rowIdColumn: pick('rowIdColumn'),
    noteColumn: pick('noteColumn')
  }
}

/** 解析日期文本：YYYY-MM-DD / YYYY/MM/DD / 中文年月日，可选时分秒。 */
export function parseDateText(text: string): { date: string; time: string } | null {
  const m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text.trim())
  if (!m) return null
  const pad = (n: string): string => n.padStart(2, '0')
  return {
    date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`,
    time: `${m[4] ? pad(m[4]) : '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`
  }
}

/** Excel 数值/字符串 → 十进制字符串（两位以内金额；toFixed(10) 只用于消除浮点尾巴）。 */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/
function amountToDecimal(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('金额不是有效数字')
    if (Number.isInteger(value)) return String(value)
    const fixed = value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')
    if (!DECIMAL_RE.test(fixed)) throw new Error(`金额非法：${value}`)
    return fixed
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (!DECIMAL_RE.test(s)) throw new Error(`金额非法：${value}`)
    return s
  }
  throw new Error(`金额格式非法：${JSON.stringify(value)}`)
}

/** 金额归一化：去逗号/货币符号/括号负号，返回正数十进制字符串 + 是否负数。 */
function normalizeAmount(raw: string, rowNumber: number): { amount: string; negative: boolean } {
  let s = raw.replace(/[,，\s¥￥]/g, '')
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1)
  } else if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  if (s === '' || s === '-') throw new Error(`第 ${rowNumber} 行金额非法：${raw || '(空)'}`)
  const amount = amountToDecimal(s)
  if (amount.startsWith('-')) {
    negative = true
  }
  const positive = amount.startsWith('-') ? amount.slice(1) : amount
  if (positive === '0') throw new Error(`第 ${rowNumber} 行金额不能为 0`)
  return { amount: positive, negative }
}

/** 方向判定（列值 / 金额正负 / 关键词 三模式）。 */
/** 明确的收支类型关键词：方向列无法识别 / 关键词模式兜底时辅助判定（转入/转出/充值/提现等歧义词不参与）。 */
const INCOME_TYPE_HINTS = ['代发工资', '工资', '代发', '退款', '利息', '收款', '入账', '报销', '奖金', '分红', '红包']
const EXPENSE_TYPE_HINTS = ['消费', '支出', '付款', '还款', '缴费', '购物', '代扣', '购买', '手续费']

function inferKindFromText(text: string): 'income' | 'expense' | null {
  if (!text) return null
  if (INCOME_TYPE_HINTS.some((k) => text.includes(k))) return 'income'
  if (EXPENSE_TYPE_HINTS.some((k) => text.includes(k))) return 'expense'
  return null
}

export function resolveKind(
  rule: ExcelDirectionRule,
  ioText: string,
  amountNegative: boolean,
  typeText: string,
  productText: string,
  rowNumber: number
): 'expense' | 'income' | 'neutral' {
  if (rule.mode === 'column') {
    const t = ioText.trim()
    // 中性：空 / 分隔符 / 中性、不计收支 等（银行流水常见不计收支 = 非收支交易）
    if (t === '' || t === '/' || /^(中性|不计收支|不计入收支|不计)/.test(t)) return 'neutral'
    if (/^收|收入|入账|转入|退款|\+|C|贷|credit/i.test(t)) return 'income'
    if (/^支|支出|出账|转出|-|D|借|debit/i.test(t)) return 'expense'
    const inferred = inferKindFromText(`${t} ${typeText}`)
    if (inferred) return inferred
    throw new Error(`第 ${rowNumber} 行方向无法识别：${t}`)
  }
  if (rule.mode === 'amountSign') {
    const positiveAs = rule.positiveAs ?? 'income'
    return amountNegative ? (positiveAs === 'income' ? 'expense' : 'income') : positiveAs
  }
  const hay = `${typeText} ${productText}`
  for (const kw of rule.neutralKeywords ?? []) {
    if (kw && hay.includes(kw)) return 'neutral'
  }
  const inferred = inferKindFromText(hay)
  if (inferred) return inferred
  return rule.defaultKind ?? 'expense'
}
function kindLabel(kind: 'expense' | 'income' | 'neutral'): '支出' | '收入' | '/' {
  return kind === 'expense' ? '支出' : kind === 'income' ? '收入' : '/'
}

/** 按方向/交易类型/支付方式 → Beancount 账户（未配置的键回退到兜底账户）。 */
function resolveRowAccounts(
  io: '支出' | '收入' | '/',
  transactionType: string,
  paymentMethod: string,
  config: AccountMappingConfig,
  accountLibrary: AccountEntry[] = [],
  product = ''
): { kind: 'expense' | 'income' | 'neutral'; expenseAccount: string; sourceAccount: string } {
  // 支付方式未映射时按账户库智能匹配（招商银行→Assets:Bank:ZSYH 等），再不行才兜底
  const methodAccount = suggestAccount(paymentMethod, accountLibrary)
  // 复合键优先（交易类型@支付方式 / 支付方式@交易类型），未命中回退单维度键
  const typeKey = typeMapKey(transactionType, paymentMethod)
  const methodKey = methodMapKey(paymentMethod, transactionType)
  if (io === '支出') {
    return {
      kind: 'expense',
      expenseAccount: config.expenseByType[typeKey]?.trim() || config.expenseByType[transactionType]?.trim() || config.fallbackExpenseAccount,
      sourceAccount: config.sourceByMethod[methodKey]?.trim() || config.sourceByMethod[paymentMethod]?.trim() || methodAccount || config.fallbackSourceAccount
    }
  }
  if (io === '收入') {
    // 退款判定同时看交易类型与摘要（银行 PDF 行交易类型常为空、退款写在摘要列）
    const refund = /退款|退货/.test(transactionType + product)
    // 工资判定只看摘要内容（不含交易类型名——避免「银联跨行代发」把余额宝赎回/微信提现/他人转账误归工资），
    // 命中优先：摘要含「代发工资/工资/奖金/转存/分红」一律按工资收入，其余走类型映射/兜底。
    const salaryHint = /工资|代发|奖金|转存|分红/.test(product)
    // 退款不是收入：钱退回到账户，应冲减对应支出科目（Expenses 记负数），而非新增 Income
    const refundExpense = refund
      ? config.expenseByType[typeKey]?.trim() || config.expenseByType[transactionType]?.trim() || 'Expenses:Uncategorized'
      : ''
    return {
      kind: 'income',
      expenseAccount:
        refundExpense ||
        (salaryHint ? 'Income:Salary' : '') ||
        config.incomeByType[typeKey]?.trim() ||
        config.incomeByType[transactionType]?.trim() ||
        (refund ? config.incomeByType['退款']?.trim() : '') ||
        config.fallbackIncomeAccount,
      sourceAccount: config.sourceByMethod[methodKey]?.trim() || config.sourceByMethod[paymentMethod]?.trim() || methodAccount || config.fallbackSourceAccount
    }
  }
  // 中性交易（/）：资产转移。支付方式命中来源/现金账户时互转；未命中回退兜底现金账户。
  const from =
    config.sourceByMethod[methodKey]?.trim() ||
    config.sourceByMethod[paymentMethod]?.trim() ||
    config.cashAccountByMethod[methodKey]?.trim() ||
    config.cashAccountByMethod[paymentMethod]?.trim() || methodAccount ||
    config.fallbackCashAccount
  const to = config.cashAccountByMethod[methodKey]?.trim() || config.cashAccountByMethod[paymentMethod]?.trim() || config.fallbackCashAccount
  const fromResolved = from === to ? config.fallbackCashAccount : from
  return {
    kind: 'neutral',
    expenseAccount: fromResolved,
    sourceAccount: to
  }
}


function sanitizeRowId(text: string): string {
  return text.replace(/\s+/g, '')
}

function computeRowId(date: string, counterparty: string, amount: string, type: string, method: string): string {
  return createHash('sha256')
    .update(`${date}|${counterparty}|${amount}|${type}|${method}`)
    .digest('hex')
    .slice(0, 16)
}

function resolveHeaderRow(grid: string[][], template: ExcelImportTemplate): number {
  if (template.headerRow && template.headerRow >= 1) {
    const idx = template.headerRow - 1
    if (idx >= grid.length) throw new Error(`指定的表头行超出文件行数：第 ${template.headerRow} 行`)
    return idx
  }
  const detected = detectHeaderRow(grid)
  if (detected === -1) throw new Error('未找到表头行，请在列映射中手动指定表头行号')
  return detected
}

/** 应用模板：网格 → 标准预览行。existingIds 为 beanwise-import 标记集合（source:rowId）；
 *  existingFpCounts 为账本中 beanwise-fp 指纹计数（跨来源去重判定用）。 */
export function applyTemplate(
  grid: string[][],
  template: ExcelImportTemplate,
  existingIds: ReadonlySet<string>,
  existingFpCounts: ReadonlyMap<string, number> = new Map(),
  accountLibrary: AccountEntry[] = []
): ExcelPreviewRow[] {
  const headerIdx = resolveHeaderRow(grid, template)
  const header = grid[headerIdx]
  const col = (name?: string): number => (name ? header.indexOf(name) : -1)
  const dateIdx = col(template.fieldMapping.dateColumn)
  const amountIdx = col(template.fieldMapping.amountColumn)
  if (dateIdx === -1) throw new Error(`找不到日期列「${template.fieldMapping.dateColumn}」，请检查列映射`)
  if (amountIdx === -1) throw new Error(`找不到金额列「${template.fieldMapping.amountColumn}」，请检查列映射`)
  const ioIdx = col(template.fieldMapping.ioColumn)
  const typeIdx = col(template.fieldMapping.typeColumn)
  const counterpartyIdx = col(template.fieldMapping.counterpartyColumn)
  const productIdx = col(template.fieldMapping.productColumn)
  const methodIdx = col(template.fieldMapping.methodColumn)
  const statusIdx = col(template.fieldMapping.statusColumn)
  const rowIdIdx = col(template.fieldMapping.rowIdColumn)
  const source = template.source || template.id

  const rows: ExcelPreviewRow[] = []
  const fileFpCounts = new Map<string, number>()
  const rowIdCounts = new Map<string, number>()
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const cells = grid[r]
    if (cells.every((c) => c === '')) continue
    const rowNumber = r + 1
    const get = (idx: number): string => (idx >= 0 && idx < cells.length ? cells[idx] : '')
    const dateText = get(dateIdx)
    const dt = parseDateText(dateText)
    if (!dt) throw new Error(`第 ${rowNumber} 行交易时间格式非法：${dateText || '(空)'}`)
    const { amount, negative } = normalizeAmount(get(amountIdx), rowNumber)
    const ioText = ioIdx >= 0 ? get(ioIdx) : ''
    const typeText = typeIdx >= 0 ? get(typeIdx) : ''
    const counterparty = counterpartyIdx >= 0 ? get(counterpartyIdx) : ''
    const product = productIdx >= 0 ? get(productIdx) : ''
    const paymentMethod = methodIdx >= 0 ? get(methodIdx) : ''
    const status = statusIdx >= 0 ? get(statusIdx) : ''
    const kind = resolveKind(template.directionRule, ioText, negative, typeText, product, rowNumber)
    const accounts = resolveRowAccounts(kindLabel(kind), typeText, paymentMethod, template.accountMapping, accountLibrary, product)
    const idCell = rowIdIdx >= 0 ? sanitizeRowId(get(rowIdIdx)) : ''
    // 内容哈希 / 单号在同一文件内可能重复（同一天同商户同金额），追加序号保证 rowId 唯一
    const baseRowId = idCell || computeRowId(dt.date, counterparty, amount, typeText, paymentMethod)
    const rowIdOccurrence = rowIdCounts.get(baseRowId) ?? 0
    rowIdCounts.set(baseRowId, rowIdOccurrence + 1)
    const rowId = rowIdOccurrence === 0 ? baseRowId : `${baseRowId}#${rowIdOccurrence + 1}`
    const fingerprint = computeDedupFingerprint(dt.date, counterparty, amount, kind)
    fileFpCounts.set(fingerprint, (fileFpCounts.get(fingerprint) ?? 0) + 1)
    rows.push({
      rowNumber,
      date: dt.date,
      time: dt.time,
      transactionType: typeText,
      counterparty,
      product,
      kind,
      amount,
      paymentMethod,
      status,
      rowId,
      alreadyImported: existingIds.has(`${source}:${rowId}`),
      fingerprint,
      dupState: 'none',
      expenseAccount: accounts.expenseAccount,
      sourceAccount: accounts.sourceAccount
    })
  }
  // 跨来源去重三级判定：账本与文件各 1 笔同指纹 → suspect（默认跳过）；
  // 任一侧 ≥2 笔 → confirm（可能是同日同额真实交易，默认保留待人工核对）。
  for (const row of rows) {
    if (row.alreadyImported) {
      row.dupState = 'exact'
      continue
    }
    const ledgerCount = existingFpCounts.get(row.fingerprint) ?? 0
    if (ledgerCount === 0) continue
    const fileCount = fileFpCounts.get(row.fingerprint) ?? 0
    row.dupState = ledgerCount >= 2 || fileCount >= 2 ? 'confirm' : 'suspect'
  }
  return rows
}

/** 新交易账户检测：收集未映射支付方式键（含中性行），聚合笔数与金额合计。 */
export function detectNewAccounts(
  rows: ExcelPreviewRow[],
  accountMapping: AccountMappingConfig,
  accountLibrary: AccountEntry[]
): ExcelNewAccountInfo[] {
  const map = new Map<string, ExcelNewAccountInfo>()
  for (const r of rows) {
    const method = r.paymentMethod.trim()
    if (!method) continue
    const type = r.transactionType.trim()
    const id = methodMapKey(method, type)
    // 已映射（复合键或单维度键命中其一即跳过）
    if (
      accountMapping.sourceByMethod[id] || accountMapping.sourceByMethod[method] ||
      accountMapping.cashAccountByMethod[id] || accountMapping.cashAccountByMethod[method]
    ) continue
    const cur = map.get(id) ?? {
      id,
      key: method,
      type,
      count: 0,
      amount: '0',
      suggestedAccount: suggestAccount(method, accountLibrary),
      resolution: 'fallback' as const
    }
    cur.count += 1
    cur.amount = addDecimalStrings(cur.amount, r.amount)
    map.set(id, cur)
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key) || a.type.localeCompare(b.type))
}

/** 常用钱包/信用支付方式的约定账户（支付宝余额/微信零钱/余额宝等业内惯用名）。 */
const WALLET_ACCOUNT_CONVENTION: Record<string, string> = {
  零钱: 'Assets:WeChat:Pay', // 微信零钱 → 微信余额-资产
  余额: 'Assets:Alipay:Balance', // 支付宝余额 → 支付宝余额-资产
  余额宝: 'Assets:Alipay:YuEBao'
}

/** 账户库模糊建议：名称包含键或键包含名称；银行类键回退到最相近的银行/卡账户。 */
export function suggestAccount(key: string, accountLibrary: AccountEntry[]): string {
  // 约定映射优先（账户库中存在对应账户才生效），避免「余额」被「微信余额-资产」抢先命中
  const convention = WALLET_ACCOUNT_CONVENTION[key]
  if (convention && accountLibrary.some((a) => a.value === convention)) return convention
  for (const a of accountLibrary) {
    const name = a.name ?? ''
    if (name && (name.includes(key) || (key.length >= 2 && key.includes(name)))) return a.value
  }
  // 复合键（「余额&现金抵价券」「零钱&红包」等）：按内含钱包词归位
  const walletHit = /余额宝|零钱|余额/.exec(key)
  if (walletHit) {
    const target =
      walletHit[0] === '余额宝'
        ? 'Assets:Alipay:YuEBao'
        : walletHit[0] === '零钱'
          ? 'Assets:WeChat:Pay'
          : 'Assets:Alipay:Balance'
    if (accountLibrary.some((a) => a.value === target)) return target
  }
  // 银行类键回退：取名称与键最长公共连续子串最长的银行/卡账户，避免固定取第一个银行账户。
  // （如「交通银行储蓄卡(3778)」应命中「交通银行储蓄卡(3378)」而非列表首个招商银行；
  //   「云闪付-招商银行(6156)」能命中「招商银行储蓄卡(6156)」。）
  if (/银行|卡|储蓄/.test(key)) {
    let best: AccountEntry | undefined
    let bestScore = 0
    for (const a of accountLibrary) {
      const name = a.name ?? ''
      if (!/银行|卡|储蓄/.test(name)) continue
      const score = longestCommonSubstringLength(name, key)
      if (score > bestScore) {
        bestScore = score
        best = a
      }
    }
    if (best) return best.value
  }
  return ''
}

/** 两个字符串的最长公共连续子串长度（账户名都很短，直接 DP，O(n*m)）。 */
function longestCommonSubstringLength(a: string, b: string): number {
  const dp: number[] = new Array(b.length + 1).fill(0)
  let best = 0
  for (let i = 1; i <= a.length; i++) {
    for (let j = b.length; j >= 1; j--) {
      dp[j] = a[i - 1] === b[j - 1] ? dp[j - 1] + 1 : 0
      if (dp[j] > best) best = dp[j]
    }
  }
  return best
}

/** 新交易类型建议：优先按模板「交易类型@支付方式 → 资金账户」惯例由支付方式推导；
 *  模板对该支付方式的既有映射以来源账户为主、或全新银行/卡/花呗/钱包类支付方式时，
 *  按支付方式建议（如 交通银行储蓄卡(3778) → Assets:Bank:JTYH、余额 → 支付宝余额）；
 *  无信号时回退到交易类型关键词建议。 */
export function suggestTypeAccountWithMethod(
  key: string,
  kind: 'expense' | 'income',
  method: string,
  config: AccountMappingConfig,
  accountLibrary: AccountEntry[]
): string {
  const hint = suggestTypeAccount(key, kind)
  if (!method.trim()) return hint
  const methodSrc =
    config.sourceByMethod[method]?.trim() ||
    config.cashAccountByMethod[method]?.trim() ||
    suggestAccount(method, accountLibrary)
  if (!methodSrc) return hint
  const map = kind === 'expense' ? config.expenseByType : config.incomeByType
  let total = 0
  let sourceHits = 0
  for (const [k, v] of Object.entries(map)) {
    if (!k.includes(method)) continue
    total += 1
    if (/^(Assets|Liabilities):/.test(v)) sourceHits += 1
  }
  // 模板对「该支付方式」的既有映射以来源账户为主 → 跟随该惯例
  if (total > 0 && sourceHits >= total / 2) return methodSrc
  // 全新支付方式：能定位到资金账户的银行/卡/花呗/钱包类 → 按支付方式建议
  if (total === 0 && /银行|卡|储蓄|花呗|余额|零钱/.test(method)) return methodSrc
  return hint
}

/** 未映射交易类型键的账户建议（关键词启发式；命中返回建议路径，未命中返回 ''）。 */
const TYPE_ACCOUNT_HINTS: Array<[RegExp, 'expense' | 'income', string]> = [
  [/退款|退货|撤销/, 'income', 'Income:Refund'],
  [/工资|代发|奖金|分红/, 'income', 'Income:Salary'],
  [/利息/, 'income', 'Income:Interest'],
  [/报销/, 'income', 'Income:Reimbursement'],
  [/收款|入账|红包|礼金/, 'income', 'Income:Other'],
  [/手续费|管理费|年费/, 'expense', 'Expenses:Fee'],
  [/消费|购物|餐饮|美食|商户|网购|扫码/, 'expense', 'Expenses:Shopping'],
  [/转账|汇款|还款|还贷/, 'expense', 'Expenses:Transfer'],
  [/缴费|水电|燃气|话费|宽带|物业/, 'expense', 'Expenses:Utilities'],
  [/加油|交通|出行|打车|停车/, 'expense', 'Expenses:Transport'],
  [/医疗|药店|医院/, 'expense', 'Expenses:Medical'],
  [/教育|学费|培训/, 'expense', 'Expenses:Education'],
  [/红包/, 'expense', 'Expenses:RedPacket']
]

export function suggestTypeAccount(key: string, kind: 'expense' | 'income'): string {
  const text = key.trim()
  if (!text) return ''
  for (const [re, k, account] of TYPE_ACCOUNT_HINTS) {
    if (k === kind && re.test(text)) return account
  }
  return ''
}

/** 新交易类型键检测（按实际导入数据）：聚合「未映射的交易类型」（支出/收入分别检测，退款属收入）。
 *  id = <kind>:<key>，同一类型文本可同时出现在支出/收入两张映射表。 */
export function detectNewTypes(
  rows: ExcelPreviewRow[],
  accountMapping: AccountMappingConfig,
  accountLibrary: AccountEntry[] = []
): ExcelNewTypeInfo[] {
  const map = new Map<string, ExcelNewTypeInfo>()
  for (const r of rows) {
    const key = r.transactionType.trim()
    if (!key || r.kind === 'neutral') continue
    const method = r.paymentMethod.trim()
    const mapKey = typeMapKey(key, method)
    // 已映射（复合键或单维度键命中其一即跳过）
    if (r.kind === 'expense' && (accountMapping.expenseByType[mapKey] || accountMapping.expenseByType[key])) continue
    if (r.kind === 'income' && (accountMapping.incomeByType[mapKey] || accountMapping.incomeByType[key])) continue
    const id = `${r.kind}:${mapKey}`
    const cur = map.get(id) ?? {
      id,
      key,
      method,
      kind: r.kind,
      count: 0,
      amount: '0',
      suggestedAccount: suggestTypeAccountWithMethod(key, r.kind, method, accountMapping, accountLibrary),
      resolution: 'fallback' as const
    }
    cur.count += 1
    cur.amount = addDecimalStrings(cur.amount, r.amount)
    map.set(id, cur)
  }
  return [...map.values()].sort((a, b) =>
    a.kind === b.kind
      ? a.key === b.key
        ? a.method.localeCompare(b.method)
        : a.key.localeCompare(b.key)
      : a.kind === 'expense' ? -1 : 1
  )
}

export function computeTotals(rows: ExcelPreviewRow[]): ExcelPreviewTotals {
  const totals: ExcelPreviewTotals = { total: rows.length, expense: 0, income: 0, neutral: 0, alreadyImported: 0, suspect: 0, confirm: 0 }
  for (const r of rows) {
    if (r.kind === 'expense') totals.expense += 1
    else if (r.kind === 'income') totals.income += 1
    else totals.neutral += 1
    if (r.alreadyImported) totals.alreadyImported += 1
    if (r.dupState === 'suspect') totals.suspect += 1
    else if (r.dupState === 'confirm') totals.confirm += 1
  }
  return totals
}
/** 从账本内容提取已导入标记（<source>:<rowId> 全 token）。 */
export function extractBeanwiseImportIds(content: string): Set<string> {
  const ids = new Set<string>()
  const re = new RegExp(`^;\\s*${BEANWISE_IMPORT_MARKER}:\\s*(\\S+)\\s*$`, 'gm')
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) ids.add(m[1])
  return ids
}

/** 去重标记行文本。 */
export function beanwiseMarker(source: string, rowId: string): string {
  return `; ${BEANWISE_IMPORT_MARKER}: ${source}:${rowId}`
}
