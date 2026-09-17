/**
 * 通用 Excel 流水导入 IPC（excel 域，M10）。
 *
 * 数据流（全部在主进程、写锁内）：
 * parse：读 xlsx/csv（编码探测）→ sheet/表头/列建议（不落账）；
 * preview：应用模板（列映射+方向+账户映射）→ 去重标记比对 → 新交易账户检测 → 预览行；
 * import：按勾选 rowId 重新解析 → 批量生成文本 → 校正 open 日期 →
 * 原子落盘（写 tmp → Python 校验 → rename）→ 索引重建 → 账户库同步。
 */
import { existsSync, readFileSync } from 'node:fs'
import type {
  AccountEntry,
  ExcelImportParams,
  ExcelImportResult,
  ExcelImportTemplate,
  ExcelParseParams,
  ExcelParseResult,
  ExcelPreviewParams,
  ExcelPreviewResult,
  ExcelTemplateDeleteResult,
  ExcelTemplateListResult,
  ExcelTemplateSaveResult
} from '../../../shared/ipc'
import type { DrizzleDb } from '../../db/index'
import { refreshIndex } from '../../core/index-builder'
import { writeLedgerChecked } from '../../utils/ledger-writer'
import type { PythonSvc } from '../../core/python-svc'
import type { IpcRegistrar } from '../ledger/ipc-handlers'
import { withWriteLock } from '../../utils/write-lock'
import { extractBeanwiseFingerprintCounts } from '../../core/dedup'
import { normalizeAccountOpens } from '../../utils/open-normalizer'
import { buildExcelImportDraft } from '../../excel/import-builder'
import { serializeOptionsHeader } from '../../core/entry-serializer'
import type { ExcelAccountStore } from '../../excel/account-label'
import { syncExcelAccountsToConfig } from '../../excel/account-label'
import type { ExcelTemplateStore } from '../../excel/types'
import { normalizeTemplate } from '../../excel/template-normalize'
import {
  applyTemplate,
  computeTotals,
  detectHeaderRow,
  detectNewAccounts,
  detectNewTypes,
  extractBeanwiseImportIds,
  readGrid,
  suggestFieldMapping
} from '../../excel/parser'

const CURRENCY_RE = /^\S+$/
const MAX_CURRENCY_LEN = 24

export interface ExcelDeps {
  db: DrizzleDb
  engine: PythonSvc
  ledgerPath: string
  templates: ExcelTemplateStore
  accountConfig: ExcelAccountStore
  showFileDialog(): Promise<{ canceled: boolean; filePaths: string[] }>
}

function validatePath(path: unknown): string {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('文件路径不能为空')
  if (!/\.(xlsx|xls|csv|txt|pdf)$/i.test(path)) throw new Error('仅支持 .xlsx / .xls / .csv / .pdf 文件')
  if (!existsSync(path)) throw new Error('文件不存在')
  return path
}

function validateParseParams(raw: unknown): ExcelParseParams {
  const p = (raw ?? {}) as Partial<ExcelParseParams>
  const path = validatePath(p.path)
  let template: ExcelImportTemplate | undefined
  if (p.template !== undefined && p.template !== null) template = normalizeTemplate(p.template)
  return template ? { path, template } : { path }
}

function validatePreviewParams(raw: unknown): ExcelPreviewParams {
  const p = (raw ?? {}) as Partial<ExcelPreviewParams>
  return { path: validatePath(p.path), template: normalizeTemplate(p.template) }
}

function validateImportParams(raw: unknown): { path: string; template: ExcelImportTemplate; rowIds: string[]; currency: string } {
  const p = (raw ?? {}) as Partial<ExcelImportParams>
  const template = normalizeTemplate(p.template)
  const path = validatePath(p.path)
  const rowIds = (p.rowIds ?? []).map((v) => String(v).trim()).filter((v) => v !== '')
  if (rowIds.length === 0) throw new Error('请至少选择一笔待导入流水')
  if (new Set(rowIds).size !== rowIds.length) throw new Error('rowIds 不能重复')
  let currency = 'CNY'
  if (p.currency !== undefined) {
    if (typeof p.currency !== 'string' || !CURRENCY_RE.test(p.currency.trim()) || p.currency.trim().length > MAX_CURRENCY_LEN) {
      throw new Error(`currency 非法：${JSON.stringify(p.currency)}`)
    }
    currency = p.currency.trim()
  }
  return { path, template, rowIds, currency }
}

function readLedgerContent(ledgerPath: string): string {
  try {
    return readFileSync(ledgerPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

function nextTemplateId(): string {
  return `excel-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function registerExcelHandlers(ipc: IpcRegistrar, deps: ExcelDeps): void {
  ipc.handle('excel:choose', async (): Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }> => {
    try {
      const result = await deps.showFileDialog()
      if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true }
      return { ok: true, path: result.filePaths[0] }
    } catch (err) {
      return { ok: false, message: String(err) }
    }
  })

  ipc.handle('excel:get-templates', (): ExcelTemplateListResult => {
    try {
      return { ok: true, templates: deps.templates.load() }
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipc.handle('excel:save-template', (_event: unknown, raw: unknown): ExcelTemplateSaveResult => {
    try {
      const template = normalizeTemplate(raw)
      const templates = deps.templates.load()
      const finalTemplate = { ...template, id: template.id || nextTemplateId() }
      const idx = templates.findIndex((t) => t.id === finalTemplate.id)
      const next = idx >= 0 ? [...templates.slice(0, idx), finalTemplate, ...templates.slice(idx + 1)] : [...templates, finalTemplate]
      deps.templates.save(next)
      return { ok: true, template: finalTemplate }
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipc.handle('excel:delete-template', (_event: unknown, raw: unknown): ExcelTemplateDeleteResult => {
    try {
      const id = (raw as { id?: unknown } | null)?.id
      if (typeof id !== 'string' || id.trim() === '') throw new Error('模板 id 不能为空')
      deps.templates.save(deps.templates.load().filter((t) => t.id !== id))
      return { ok: true }
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipc.handle('excel:parse', async (_event: unknown, raw: unknown): Promise<ExcelParseResult> => {
    try {
      const params = validateParseParams(raw)
      const { sheets, grid } = await readGrid(params.path, params.template?.sheetName)
      const headerRow = params.template?.headerRow ?? detectHeaderRow(grid)
      const columns = headerRow >= 0 && grid[headerRow] ? grid[headerRow] : (grid[0] ?? [])
      const suggestedMapping = headerRow >= 0 ? suggestFieldMapping(columns) : undefined
      const sampleStart = headerRow >= 0 ? headerRow + 1 : 1
      const sampleRows = grid.slice(sampleStart, sampleStart + 3).map((row) => row.slice(0, 20))
      return { ok: true, sheets, headerRow: headerRow >= 0 ? headerRow + 1 : undefined, columns, suggestedMapping, sampleRows }
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipc.handle('excel:preview', async (_event: unknown, raw: unknown): Promise<ExcelPreviewResult> => {
    try {
      const params = validatePreviewParams(raw)
      const { grid } = await readGrid(params.path, params.template.sheetName)
      const ledgerContent = readLedgerContent(deps.ledgerPath)
      const existingIds = extractBeanwiseImportIds(ledgerContent)
      const existingFpCounts = extractBeanwiseFingerprintCounts(ledgerContent)
      const rows = applyTemplate(grid, params.template, existingIds, existingFpCounts, deps.accountConfig.load())
      const newAccounts = detectNewAccounts(rows, params.template.accountMapping, deps.accountConfig.load())
      const newTypes = detectNewTypes(rows, params.template.accountMapping, deps.accountConfig.load())
      return { ok: true, rows, newAccounts, newTypes, totals: computeTotals(rows) }
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipc.handle('excel:import', (_event: unknown, raw: unknown): Promise<ExcelImportResult> =>
    withWriteLock(async () => {
      const params = validateImportParams(raw)
      try {
        const ledgerContent = readLedgerContent(deps.ledgerPath)
        const existingIds = extractBeanwiseImportIds(ledgerContent)
        const existingFpCounts = extractBeanwiseFingerprintCounts(ledgerContent)
        const { grid } = await readGrid(params.path, params.template.sheetName)
        const rows = applyTemplate(grid, params.template, existingIds, existingFpCounts, deps.accountConfig.load())
        const selected = rows.filter((r) => params.rowIds.includes(r.rowId))
        if (selected.length === 0) return { ok: false, message: '没有可导入的流水记录' }

        const source = params.template.source || params.template.id
        const drafts = selected.map((r) => buildExcelImportDraft(r, source, params.currency))
        const accounts = [...new Set(drafts.flatMap((d) => d.entry.postings.map((p) => p.account)))]
        const minDate = drafts.reduce((a, d) => (d.entry.date < a ? d.entry.date : a), drafts[0].entry.date)
        let content = normalizeAccountOpens(ledgerContent, accounts, minDate) +
          drafts.map((d) => d.appendBlock).join('')
        // 空账本首导：补 options 头（title + operating_currency）——缺运营货币报表图表恒空
        // （2026-08-23 回归修复，与首笔录入 serializeFirstEntryBlock 同口径）
        if (ledgerContent.trim() === '' && !/^option\s+/m.test(content)) {
          content = serializeOptionsHeader(params.currency ?? 'CNY') + content
        }
        const written = await writeLedgerChecked({ ledgerPath: deps.ledgerPath, engine: deps.engine }, content)
        if (!written.ok) {
          return { ok: false, message: written.message, imported: 0, skipped: selected.length }
        }
        const result = await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
        if (result.status === 'error') {
          return {
            ok: false,
            message: result.message,
            status: result.status,
            entryCount: result.entryCount,
            errorCount: result.errorCount,
            imported: 0,
            skipped: selected.length
          }
        }
        try {
          syncExcelAccountsToConfig(accounts, params.template, deps.accountConfig)
        } catch (syncErr) {
          console.error('[BeanWise] Excel 导入账户同步失败（账本已写入，可稍后手工补账户设置）:', syncErr)
        }
        return {
          ok: true,
          imported: selected.length,
          skipped: rows.length - selected.length,
          status: result.status,
          entryCount: result.entryCount,
          errorCount: result.errorCount
        }
      } catch (err) {
        return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
      }
    }))
}
