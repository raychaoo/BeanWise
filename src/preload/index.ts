import { contextBridge, ipcRenderer } from 'electron'
import { APP_NAME } from '../shared/app'
import type { BeanWiseApi } from '../shared/api'
import { UPDATE_STATUS_CHANNEL } from '../shared/ipc'
import type { AddEntryParams, AiParseParams, ConfigureSyncParams, ExcelImportParams, ExcelImportTemplate, ExcelParseParams, ExcelPreviewParams, ListEntriesParams, ReportBalancesParams, ReportBreakdownParams, ReportCashFlowParams, ReportIncomeExpenseParams, ReportNetWorthParams, ReportTrialBalanceParams, ReportYearsResult, ResolveConflictParams, SaveAccountsParams, SaveAiConfigParams, SaveFileParams, UpdateState } from '../shared/ipc'

const api: BeanWiseApi = {
  appName: APP_NAME,
  getWorkspaceStatus: () => ipcRenderer.invoke('workspace:get-status'),
  chooseWorkspaceFolder: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: (path: string) => ipcRenderer.invoke('workspace:open', { path }),
  getWorkspaceRecents: () => ipcRenderer.invoke('workspace:recents'),
  renameWorkspace: (path: string, newName: string) => ipcRenderer.invoke('workspace:rename', { path, newName }),
  archiveWorkspace: (path: string) => ipcRenderer.invoke('workspace:archive', { path }),
  deleteWorkspace: (path: string) => ipcRenderer.invoke('workspace:delete', { path }),
  refreshLedgerIndex: () => ipcRenderer.invoke('ledger:refresh-index'),
  getLedgerStatus: () => ipcRenderer.invoke('ledger:status'),
  listLedgerEntries: (params: ListEntriesParams) => ipcRenderer.invoke('ledger:list-entries', params),
  addLedgerEntry: (params: AddEntryParams) => ipcRenderer.invoke('ledger:add-entry', params),
  listLedgerAccounts: () => ipcRenderer.invoke('ledger:list-accounts'),
  getAccountConfig: () => ipcRenderer.invoke('accounts:get'),
  saveAccountConfig: (params: SaveAccountsParams) => ipcRenderer.invoke('accounts:save', params),
  chooseExcelFile: () => ipcRenderer.invoke('excel:choose'),
  parseExcelFile: (params: ExcelParseParams) => ipcRenderer.invoke('excel:parse', params),
  previewExcelImport: (params: ExcelPreviewParams) => ipcRenderer.invoke('excel:preview', params),
  importExcel: (params: ExcelImportParams) => ipcRenderer.invoke('excel:import', params),
  getExcelTemplates: () => ipcRenderer.invoke('excel:get-templates'),
  saveExcelTemplate: (template: ExcelImportTemplate) => ipcRenderer.invoke('excel:save-template', template),
  deleteExcelTemplate: (id: string) => ipcRenderer.invoke('excel:delete-template', { id }),
  readLedgerFile: () => ipcRenderer.invoke('ledger:read-file'),
  saveLedgerFile: (params: SaveFileParams) => ipcRenderer.invoke('ledger:save-file', params),
  clearLedger: () => ipcRenderer.invoke('ledger:clear'),
  getSyncStatus: () => ipcRenderer.invoke('sync:get-status'),
  configureSync: (params: ConfigureSyncParams) => ipcRenderer.invoke('sync:configure', params),
  pushLedger: () => ipcRenderer.invoke('sync:push'),
  pullLedger: () => ipcRenderer.invoke('sync:pull'),
  resolveSyncConflict: (params: ResolveConflictParams) => ipcRenderer.invoke('sync:resolve-conflict', params),
  clearSync: () => ipcRenderer.invoke('sync:clear'),
  getAiStatus: () => ipcRenderer.invoke('ai:get-status'),
  saveAiConfig: (params: SaveAiConfigParams) => ipcRenderer.invoke('ai:save-config', params),
  clearAiConfig: () => ipcRenderer.invoke('ai:clear-config'),
  parseAiEntry: (text: string) => ipcRenderer.invoke('ai:parse', { text } satisfies AiParseParams),
  getNetWorthReport: (params: ReportNetWorthParams) => ipcRenderer.invoke('report:net-worth', params),
  getBalancesReport: (params?: ReportBalancesParams) => ipcRenderer.invoke('report:balances', params),
  getIncomeExpenseReport: (params: ReportIncomeExpenseParams) => ipcRenderer.invoke('report:income-expense', params),
  getReportYears: (): Promise<ReportYearsResult> => ipcRenderer.invoke('report:years'),
  getTrialBalanceReport: (params?: ReportTrialBalanceParams) => ipcRenderer.invoke('report:trial-balance', params),
  getCashFlowReport: (params: ReportCashFlowParams) => ipcRenderer.invoke('report:cash-flow', params),
  getBreakdownReport: (params: ReportBreakdownParams) => ipcRenderer.invoke('report:breakdown', params),
  exportReportPdf: () => ipcRenderer.invoke('report:export-pdf'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatusChanged: (cb: (state: UpdateState) => void) => {
    const listener = (_e: unknown, state: UpdateState) => cb(state)
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener)
    return () => { ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener) }
  }
}

contextBridge.exposeInMainWorld('beanwise', api)
