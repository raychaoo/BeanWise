import { contextBridge, ipcRenderer } from 'electron'
import { APP_NAME } from '../shared/app'
import type { BeanWiseApi } from '../shared/api'
import type { AddEntryParams, ListEntriesParams } from '../shared/ipc'

const api: BeanWiseApi = {
  appName: APP_NAME,
  refreshLedgerIndex: () => ipcRenderer.invoke('ledger:refresh-index'),
  getLedgerStatus: () => ipcRenderer.invoke('ledger:status'),
  listLedgerEntries: (params: ListEntriesParams) => ipcRenderer.invoke('ledger:list-entries', params),
  addLedgerEntry: (params: AddEntryParams) => ipcRenderer.invoke('ledger:add-entry', params),
  listLedgerAccounts: () => ipcRenderer.invoke('ledger:list-accounts')
}

contextBridge.exposeInMainWorld('beanwise', api)
