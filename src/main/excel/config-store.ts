/**
 * 通用 Excel 导入模板持久化（M10）：每工作目录一份 .beanwise/excel-import-templates.json。
 * 多模板：招商银行信用卡 / 支付宝 / 任意对账单，各自持有列映射 + 方向规则 + 账户映射。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExcelImportTemplate } from '../../shared/ipc'

interface ExcelTemplateFile {
  templates: ExcelImportTemplate[]
}

export class JsonExcelTemplateStore {
  constructor(private readonly filePath: string) {}

  load(): ExcelImportTemplate[] {
    try {
      if (!existsSync(this.filePath)) return []
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as ExcelTemplateFile
      return Array.isArray(raw.templates) ? raw.templates : []
    } catch {
      return []
    }
  }

  save(templates: ExcelImportTemplate[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ templates }, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }
}
