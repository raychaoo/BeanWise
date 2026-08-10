import { contextBridge, ipcRenderer } from 'electron'
import { APP_NAME } from '../shared/app'
import type { BeanWiseApi } from '../shared/api'
import type { AddEntryParams, ConfigureSyncParams, ListEntriesParams, ResolveConflictParams, SaveFileParams } from '../shared/ipc'

const api: BeanWiseApi = {
  appName: APP_NAME,
  refreshLedgerIndex: () => ipcRenderer.invoke('ledger:refresh-index'),
  getLedgerStatus: () => ipcRenderer.invoke('ledger:status'),
  listLedgerEntries: (params: ListEntriesParams) => ipcRenderer.invoke('ledger:list-entries', params),
  addLedgerEntry: (params: AddEntryParams) => ipcRenderer.invoke('ledger:add-entry', params),
  listLedgerAccounts: () => ipcRenderer.invoke('ledger:list-accounts'),
  readLedgerFile: () => ipcRenderer.invoke('ledger:read-file'),
  saveLedgerFile: (params: SaveFileParams) => ipcRenderer.invoke('ledger:save-file', params),
  getSyncStatus: () => ipcRenderer.invoke('sync:get-status'),
  configureSync: (params: ConfigureSyncParams) => ipcRenderer.invoke('sync:configure', params),
  pushLedger: () => ipcRenderer.invoke('sync:push'),
  pullLedger: () => ipcRenderer.invoke('sync:pull'),
  resolveSyncConflict: (params: ResolveConflictParams) => ipcRenderer.invoke('sync:resolve-conflict', params),
  clearSync: () => ipcRenderer.invoke('sync:clear')
}

contextBridge.exposeInMainWorld('beanwise', api)
