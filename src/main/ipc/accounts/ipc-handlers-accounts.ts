/** 通用账户库 IPC：读取 / 保存当前工作目录的 accounts.json。 */
import type { AccountsResult, SaveAccountsParams } from '../../../shared/ipc'
import type { AccountEntry } from '../../../shared/ipc'
import { normalizeAccounts } from '../../utils/account-normalize'
import type { IpcRegistrar } from '../ledger/ipc-handlers'

// 结构化校验已抽到 utils/account-normalize（同步合并引擎复用同一份规则）；此处 re-export 保持既有导入不破
export { normalizeAccounts }

export interface AccountConfigStore {
  load(): AccountEntry[]
  save(accounts: AccountEntry[]): void
  nextId(): number
}

export interface AccountDeps {
  store: AccountConfigStore
}

export function registerAccountHandlers(ipc: IpcRegistrar, deps: AccountDeps): void {
  ipc.handle('accounts:get', (): AccountsResult => ({ ok: true, accounts: deps.store.load() }))

  ipc.handle('accounts:save', (_event: unknown, raw: unknown): AccountsResult => {
    try {
      const params = (raw ?? {}) as Partial<SaveAccountsParams>
      const accounts = normalizeAccounts(params.accounts)
      // 为 id=0 的新条目分配自增 id（新建场景）
      const existingIds = new Set(accounts.filter((e) => e.id > 0).map((e) => e.id))
      let nextId = deps.store.nextId()
      for (const entry of accounts) {
        if (!existingIds.has(entry.id)) {
          entry.id = nextId++
        }
      }
      accounts.sort((a, b) => a.id - b.id)
      deps.store.save(accounts)
      return { ok: true, accounts }
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, '') }
    }
  })
}
