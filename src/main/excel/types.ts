import type { ExcelImportTemplate } from '../../shared/ipc'

export interface ExcelTemplateStore {
  load(): ExcelImportTemplate[]
  save(templates: ExcelImportTemplate[]): void
}
