/** 通用账户库 IPC：读取 / 保存当前工作目录的 accounts.json。 */
import type { AccountsResult, SaveAccountsParams } from '../../../shared/ipc'
import type { AccountEntry } from '../../../shared/ipc'
import type { IpcRegistrar } from '../ledger/ipc-handlers'

export interface AccountConfigStore {
  load(): AccountEntry[]
  save(accounts: AccountEntry[]): void
  nextId(): number
}

export interface AccountDeps {
  store: AccountConfigStore
}

const ACCOUNT_RE = /^[A-Z]\S*:\S*$/
const MAX_NAME_LEN = 100
const MAX_DESC_LEN = 200
const MAX_ACCOUNTS = 500
const MAX_ACCOUNT_LEN = 200

export function normalizeAccounts(raw: unknown): AccountEntry[] {
  if (!Array.isArray(raw)) throw new Error('accounts 必须为数组')
  const entries: AccountEntry[] = raw.map((item, idx) => {
    if (typeof item !== 'object' || item === null) throw new Error(`accounts[${idx}] 必须为对象`)
    const e = item as Record<string, unknown>
    if (typeof e.id !== 'number' || !Number.isInteger(e.id) || e.id < 0) {
      throw new Error(`accounts[${idx}].id 必须为非负整数`)
    }
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.trim().length > MAX_NAME_LEN) {
      throw new Error(`accounts[${idx}].name 不能为空且不超过 ${MAX_NAME_LEN} 字符`)
    }
    const description = typeof e.description === 'string' ? e.description.trim() : ''
    if (description.length > MAX_DESC_LEN) {
      throw new Error(`accounts[${idx}].description 长度不能超过 ${MAX_DESC_LEN} 字符`)
    }
    const value = typeof e.value === 'string' ? e.value.trim() : ''
    if (!value || !ACCOUNT_RE.test(value)) throw new Error(`accounts[${idx}].value 非法：${e.value}`)
    if (value.length > MAX_ACCOUNT_LEN) throw new Error(`accounts[${idx}].value 长度不能超过 ${MAX_ACCOUNT_LEN} 字符`)
    // 批次 I：enabled 停用标记透传（非 boolean 视为未设置；undefined 序列化时省略）
    const enabled = typeof e.enabled === 'boolean' ? e.enabled : undefined
    return {
      id: e.id,
      name: e.name.trim(),
      value,
      description,
      ...(enabled === undefined ? {} : { enabled })
    }
  })
  const values = entries.map((e) => e.value)
  if (new Set(values).size !== values.length) throw new Error('账户路径不能重复')
  if (entries.length > MAX_ACCOUNTS) throw new Error(`最多配置 ${MAX_ACCOUNTS} 个账户`)
  return entries.sort((a, b) => a.id - b.id)
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
