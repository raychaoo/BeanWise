import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExcelImportTemplate,
  ExcelParseResult,
  ExcelPreviewResult,
  ExcelTemplateListResult,
  ExcelTemplateSaveResult
} from '../shared/ipc'
import { createDrizzle, openDatabase } from './db'
import type { IpcRegistrar } from './ipc-handlers'
import { registerExcelHandlers, type ExcelDeps } from './ipc-handlers-excel'
import { defaultAccountMapping } from './excel/account-mapping'
import { extractBeanwiseImportIds } from './excel/parser'

const mocks = vi.hoisted(() => ({ refreshIndex: vi.fn(), writeLedgerChecked: vi.fn() }))
vi.mock('./index-builder', () => ({ refreshIndex: mocks.refreshIndex }))
vi.mock('./ledger-writer', () => ({ writeLedgerChecked: mocks.writeLedgerChecked }))

function makeHandlers(deps: ExcelDeps): Record<string, (...args: unknown[]) => unknown> {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const ipc: IpcRegistrar = { handle: (channel, listener) => { handlers[channel] = listener } }
  registerExcelHandlers(ipc, deps)
  return handlers
}

const TEMPLATE: ExcelImportTemplate = {
  id: 't1',
  name: '测试模板',
  source: 'test-src',
  fieldMapping: {
    dateColumn: '交易时间',
    amountColumn: '金额',
    ioColumn: '收/支',
    typeColumn: '交易类型',
    counterpartyColumn: '交易对方',
    productColumn: '商品',
    methodColumn: '支付方式',
    rowIdColumn: '交易单号'
  },
  directionRule: { mode: 'column' },
  accountMapping: defaultAccountMapping()
}

const HEADER = ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号']
const ROWS = [
  [new Date(Date.UTC(2026, 7, 21, 16, 9, 20)), '商户消费', '麦当劳', '麦当劳', 17.4, '支出', '招商银行储蓄卡(8888)', 'A1'],
  [new Date(Date.UTC(2026, 7, 20, 13, 1, 29)), '转账', '杜永奇', '转账备注', 500, '收入', '零钱', 'B2'],
  [new Date(Date.UTC(2026, 7, 19, 8, 18, 17)), '零钱提现', '微信', '', 1000, '/', '招商银行储蓄卡(8888)', 'C3']
]

describe('excel 域 IPC（通用导入）', () => {
  let dir: string
  let ledgerPath: string
  let xlsxPath: string
  let csvPath: string
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let db: ReturnType<typeof createDrizzle>
  let accountSave: (accounts: Array<{ id: number; name: string; value: string }>) => void
  let templateSave: (templates: ExcelImportTemplate[]) => void

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'beanwise-excel-ipc-'))
    ledgerPath = join(dir, 'main.beancount')
    appendFileSync(ledgerPath, '2026-01-01 open Assets:WeChat\n2026-01-01 open Expenses:Shopping\n', 'utf8')

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('流水')
    ws.addRow(HEADER)
    ROWS.forEach((r) => ws.addRow(r))
    xlsxPath = join(dir, 'bill.xlsx')
    await wb.xlsx.writeFile(xlsxPath)
    csvPath = join(dir, 'bill.csv')
    writeFileSync(csvPath, [HEADER.join(','), ...ROWS.map((r) => [(r[0] as Date).toISOString(), r[1], r[2], r[3], r[4], r[5], r[6], r[7]].join(','))].join('\n'), 'utf8')

    db = createDrizzle(openDatabase(':memory:'))
    mocks.refreshIndex.mockReset()
    mocks.refreshIndex.mockResolvedValue({ changed: true, status: 'ok', entryCount: 26, errorCount: 0 })
    mocks.writeLedgerChecked.mockReset()
    mocks.writeLedgerChecked.mockImplementation(async (_deps: unknown, content: string) => {
      writeFileSync(ledgerPath, content, 'utf8')
      return { ok: true }
    })
    accountSave = vi.fn()
    templateSave = vi.fn()
    handlers = makeHandlers({
      db,
      engine: {} as never,
      ledgerPath,
      templates: {
        load: () => [],
        save: templateSave
      },
      accountConfig: {
        load: () => [],
        save: accountSave,
        nextId: () => 1
      },
      showFileDialog: async () => ({ canceled: false, filePaths: [xlsxPath] })
    })
  })

  afterEach(() => {
    db.$client.close()
    require('node:fs').rmSync(dir, { recursive: true, force: true })
  })

  it('parse 返回 sheet/列头/表头行/列映射建议', async () => {
    const result = (await handlers['excel:parse']({}, { path: xlsxPath })) as ExcelParseResult
    expect(result.ok).toBe(true)
    expect(result.sheets).toEqual(['流水'])
    expect(result.headerRow).toBe(1)
    expect(result.columns).toEqual(HEADER)
    expect(result.suggestedMapping?.dateColumn).toBe('交易时间')
    expect(result.suggestedMapping?.amountColumn).toBe('金额')
  })

  it('preview 返回 3 行 + 新交易账户检测 + totals', async () => {
    const result = (await handlers['excel:preview']({}, { path: xlsxPath, template: TEMPLATE })) as ExcelPreviewResult
    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(3)
    expect(result.newAccounts).toHaveLength(2)
    expect(result.newAccounts?.[0]).toMatchObject({ id: '招商银行储蓄卡(8888)@零钱提现', key: '招商银行储蓄卡(8888)', type: '零钱提现', count: 1, amount: '1000' })
    expect(result.newAccounts?.[1]).toMatchObject({ id: '招商银行储蓄卡(8888)@商户消费', key: '招商银行储蓄卡(8888)', type: '商户消费', count: 1, amount: '17.4' })
    expect(result.totals).toMatchObject({ total: 3, expense: 1, income: 1, neutral: 1 })
    expect(result.rows?.[0]).toMatchObject({ rowId: 'A1', kind: 'expense', expenseAccount: 'Expenses:Shopping', sourceAccount: 'Assets:WeChat' })
  })


  it('preview 返回未映射交易类型键（newTypes，按实际导入数据聚合）', async () => {
    const tpl: ExcelImportTemplate = {
      ...TEMPLATE,
      accountMapping: { ...TEMPLATE.accountMapping, expenseByType: {}, incomeByType: {} }
    }
    const result = (await handlers['excel:preview']({}, { path: xlsxPath, template: tpl })) as ExcelPreviewResult
    expect(result.ok).toBe(true)
    const types = result.newTypes ?? []
    expect(types).toContainEqual(expect.objectContaining({ id: 'expense:商户消费@招商银行储蓄卡(8888)', key: '商户消费', method: '招商银行储蓄卡(8888)', kind: 'expense', count: 1, amount: '17.4', suggestedAccount: 'Expenses:Shopping', resolution: 'fallback' }))
    expect(types).toContainEqual(expect.objectContaining({ id: 'income:转账@零钱', key: '转账', method: '零钱', kind: 'income', count: 1, amount: '500' }))
    expect(types.some((t) => t.key === '零钱提现')).toBe(false) // 中性行不参与
  })

  it('import 使用新类型映射（写回模板后按指定账户记账）', async () => {
    const tpl: ExcelImportTemplate = {
      ...TEMPLATE,
      accountMapping: { ...TEMPLATE.accountMapping, expenseByType: { '商户消费': 'Expenses:Food' } }
    }
    const result = (await handlers['excel:import']({}, { path: xlsxPath, template: tpl, rowIds: ['A1'] })) as { ok: boolean; imported?: number }
    expect(result.ok).toBe(true)
    expect(result.imported).toBe(1)
    const content = readFileSync(ledgerPath, 'utf8')
    expect(content).toContain('Expenses:Food')
  })

  it('空账本首导：补 options 头（title + operating_currency），报表图表不再恒空（2026-08-23 回归修复）', async () => {
    rmSync(ledgerPath, { force: true })
    const result = (await handlers['excel:import']({}, { path: xlsxPath, template: TEMPLATE, rowIds: ['A1'] })) as { ok: boolean; imported?: number }
    expect(result.ok).toBe(true)
    const content = readFileSync(ledgerPath, 'utf8')
    expect(content).toMatch(/^option "title" "BeanWise"\noption "operating_currency" "CNY"\n\n2026-08-21 open /)
    expect(content).toContain('; beanwise-import: test-src:A1')
  })

  it('import 写入勾选行 + 去重标记 + 索引重建 + 账户库同步', async () => {
    const result = (await handlers['excel:import']({}, {
      path: xlsxPath,
      template: TEMPLATE,
      rowIds: ['A1', 'B2', 'C3']
    })) as { ok: boolean; imported?: number; skipped?: number }
    expect(result.ok).toBe(true)
    expect(result.imported).toBe(3)
    expect(mocks.refreshIndex).toHaveBeenCalledTimes(1)
    const content = readFileSync(ledgerPath, 'utf8')
    expect(content).toContain('; beanwise-import: test-src:A1')
    expect(extractBeanwiseImportIds(content).size).toBe(3)
    const saveMock = accountSave as unknown as { mock: { calls: Array<[Array<{ value: string }>]> } }
    expect(saveMock.mock.calls.length).toBeGreaterThan(0)
    const saved = saveMock.mock.calls[0][0]
    expect(saved.some((a) => a.value === 'Expenses:Shopping')).toBe(true)
  })

  it('重复导入同一行被去重（existingIds 命中）', async () => {
    await handlers['excel:import']({}, { path: xlsxPath, template: TEMPLATE, rowIds: ['A1'] })
    const result = (await handlers['excel:preview']({}, { path: xlsxPath, template: TEMPLATE })) as ExcelPreviewResult
    expect(result.rows?.find((r) => r.rowId === 'A1')?.alreadyImported).toBe(true)
  })

  it('跨来源去重：不同来源模板预览同一流水 → 指纹命中 suspect，账本写入 beanwise-fp', async () => {
    await handlers['excel:import']({}, { path: xlsxPath, template: TEMPLATE, rowIds: ['A1', 'B2', 'C3'] })
    const ledger = readFileSync(ledgerPath, 'utf8')
    expect(ledger).toContain('; beanwise-fp: ')
    const bankTemplate: ExcelImportTemplate = { ...TEMPLATE, id: 't2', source: 'bank-src', name: '银行卡流水' }
    const result = (await handlers['excel:preview']({}, { path: xlsxPath, template: bankTemplate })) as ExcelPreviewResult
    expect(result.ok).toBe(true)
    const a1 = result.rows?.find((r) => r.rowId === 'A1')
    expect(a1?.alreadyImported).toBe(false) // 来源不同，rowId 不命中
    expect(a1?.dupState).toBe('suspect')
    expect(result.totals).toMatchObject({ total: 3, alreadyImported: 0, suspect: 3, confirm: 0 })
  })
  it('import 拒绝空勾选；preview 拒绝非 excel 路径', async () => {
    await expect(handlers['excel:import']({}, { path: xlsxPath, template: TEMPLATE, rowIds: [] })).rejects.toThrow(/至少选择/)
    const bad = (await handlers['excel:preview']({}, { path: join(dir, 'bill.xyz'), template: TEMPLATE })) as ExcelPreviewResult
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/仅支持/)
  })

  it('save-template 新建分配 id / 覆盖 / 校验失败', async () => {
    const created = (await handlers['excel:save-template']({}, { ...TEMPLATE, id: '' })) as ExcelTemplateSaveResult
    expect(created.ok).toBe(true)
    expect(created.template?.id).toMatch(/^excel-/)
    const bad = (await handlers['excel:save-template']({}, { ...TEMPLATE, accountMapping: { ...TEMPLATE.accountMapping, fallbackExpenseAccount: 'bad' } })) as ExcelTemplateSaveResult
    expect(bad.ok).toBe(false)
  })

  it('get-templates / delete-template', async () => {
    const got = (await handlers['excel:get-templates']()) as ExcelTemplateListResult
    expect(got.ok).toBe(true)
    expect(got.templates).toEqual([])
    const del = (await handlers['excel:delete-template']({}, { id: 't1' })) as { ok: boolean }
    expect(del.ok).toBe(true)
    expect(templateSave).toHaveBeenCalled()
  })

  it('xls 文件可解析（旧版 Excel 97-2003，招商银行样例）', async () => {
    const xlsPath = fileURLToPath(new URL('./excel/fixtures/cmb-sample.xls', import.meta.url))
    const result = (await handlers['excel:parse']({}, { path: xlsPath })) as ExcelParseResult
    expect(result.ok).toBe(true)
    expect(result.headerRow).toBe(1)
    expect(result.columns?.[0]).toBe('记账日期')
    expect(result.suggestedMapping?.dateColumn).toBe('记账日期')
    expect(result.suggestedMapping?.amountColumn).toBe('交易金额')
    expect(result.sampleRows?.[0]?.[0]).toBe('2022-09-12')
  })
  it('pdf 文件可解析（招商银行流水样例：表头识别 + 列建议）', async () => {
    const pdfPath = fileURLToPath(new URL('./excel/fixtures/cmb-sample.pdf', import.meta.url))
    const result = (await handlers['excel:parse']({}, { path: pdfPath })) as ExcelParseResult
    expect(result.ok).toBe(true)
    expect(result.sheets).toEqual(['PDF'])
    expect(result.headerRow).toBe(1)
    expect(result.columns?.[0]).toBe('记账日期')
    expect(result.suggestedMapping?.dateColumn).toBe('记账日期')
    expect(result.suggestedMapping?.amountColumn).toBe('交易金额')
    expect(result.suggestedMapping?.counterpartyColumn).toBe('对手信息')
    expect(result.sampleRows?.[0]?.[0]).toBe('2022-09-12')
  })
  it('csv 文件同样可解析（ISO 日期）', async () => {
    const result = (await handlers['excel:preview']({}, { path: csvPath, template: TEMPLATE })) as ExcelPreviewResult
    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(3)
  })
})
