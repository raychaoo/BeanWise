import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountsResult } from '../../../shared/ipc'
import { JsonAccountConfigStore } from '../../stores/account-config-store'
import { normalizeAccounts } from '../../utils/account-normalize'
import { registerAccountHandlers } from './ipc-handlers-accounts'
import type { IpcRegistrar } from '../ledger/ipc-handlers'

describe('normalizeAccounts（id/name/value/description 结构）', () => {
  it('允许 id=0 新条目并保留 description', () => {
    expect(normalizeAccounts([
      { id: 0, name: '新银行卡', value: 'Assets:Bank:CNB', description: '日常收款' },
      { id: 1, name: '餐饮', value: 'Expenses:Food', description: '吃饭' }
    ])).toEqual([
      { id: 0, name: '新银行卡', value: 'Assets:Bank:CNB', description: '日常收款' },
      { id: 1, name: '餐饮', value: 'Expenses:Food', description: '吃饭' }
    ])
  })

  it('拒绝重复路径；拒绝非法路径格式', () => {
    expect(() => normalizeAccounts([
      { id: 0, name: 'A', value: 'Assets:A' },
      { id: 1, name: 'B', value: 'Assets:A' }
    ])).toThrow(/重复/)
    expect(() => normalizeAccounts([{ id: 0, name: 'A', value: 'assets:a' }])).toThrow(/非法/)
  })

  it('enabled 停用标记透传：boolean 原样保留，非 boolean 归一为 undefined（批次 I）', () => {
    const normalized = normalizeAccounts([
      { id: 1, name: '停用卡', value: 'Assets:Old', enabled: false },
      { id: 2, name: '启用卡', value: 'Assets:New', enabled: true },
      { id: 3, name: '缺省卡', value: 'Assets:Default' },
      { id: 4, name: '脏值卡', value: 'Assets:Dirty', enabled: 'yes' as unknown as boolean }
    ])
    expect(normalized.find((a) => a.id === 1)?.enabled).toBe(false)
    expect(normalized.find((a) => a.id === 2)?.enabled).toBe(true)
    expect(normalized.find((a) => a.id === 3)).not.toHaveProperty('enabled')
    expect(normalized.find((a) => a.id === 4)?.enabled).toBeUndefined()
  })

  it('counterparty 往来类标记透传：boolean 原样保留，非 boolean 归一为 undefined（ADR 23）', () => {
    // 本函数逐字段白名单构造返回值——不显式透传的字段会在保存时被静默丢弃，故必须锁住
    const normalized = normalizeAccounts([
      { id: 1, name: '借出', value: 'Assets:Receivables:Lend', counterparty: true },
      { id: 2, name: '借入', value: 'Liabilities:Loans:Repay', counterparty: false },
      { id: 3, name: '银行卡', value: 'Assets:Bank:CNB' },
      { id: 4, name: '脏值卡', value: 'Assets:Dirty', counterparty: 'yes' as unknown as boolean }
    ])
    expect(normalized.find((a) => a.id === 1)?.counterparty).toBe(true)
    expect(normalized.find((a) => a.id === 2)?.counterparty).toBe(false)
    expect(normalized.find((a) => a.id === 3)).not.toHaveProperty('counterparty')
    expect(normalized.find((a) => a.id === 4)?.counterparty).toBeUndefined()
  })
})

describe('accounts:save（新建条目自增 id）', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('id=0 新条目分配自增 id 并持久化', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beanwise-accounts-handler-'))
    dirs.push(dir)
    const store = new JsonAccountConfigStore(join(dir, '.beanwise', 'accounts.json'))
    store.save([{ id: 1, name: '餐饮', value: 'Expenses:Food', description: '吃饭' }])

    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const ipc: IpcRegistrar = {
      handle: (channel, listener) => {
        handlers[channel] = listener as (...args: unknown[]) => unknown
      }
    }
    registerAccountHandlers(ipc, { store })

    const result = await handlers['accounts:save']({}, {
      accounts: [
        { id: 1, name: '餐饮', value: 'Expenses:Food', description: '吃饭' },
        { id: 0, name: '银行卡', value: 'Assets:Bank:CNB', description: '日常收款' }
      ]
    }) as AccountsResult

    expect(result.ok).toBe(true)
    expect(result.accounts).toEqual([
      { id: 1, name: '餐饮', value: 'Expenses:Food', description: '吃饭' },
      { id: 2, name: '银行卡', value: 'Assets:Bank:CNB', description: '日常收款' }
    ])
    expect(store.load()).toEqual(result.accounts)
  })

  it('accounts:save 全链路：enabled=false 落盘后 accounts:get 读回保持（批次 I IPC 层回归）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beanwise-accounts-enabled-'))
    dirs.push(dir)
    const store = new JsonAccountConfigStore(join(dir, '.beanwise', 'accounts.json'))

    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const ipc: IpcRegistrar = {
      handle: (channel, listener) => {
        handlers[channel] = listener as (...args: unknown[]) => unknown
      }
    }
    registerAccountHandlers(ipc, { store })

    const save = await handlers['accounts:save']({}, {
      accounts: [
        { id: 1, name: '银行卡', value: 'Assets:Bank:CNB', enabled: false },
        { id: 2, name: '吃饭', value: 'Expenses:Food' }
      ]
    }) as AccountsResult
    expect(save.ok).toBe(true)

    const raw = JSON.parse(readFileSync(join(dir, '.beanwise', 'accounts.json'), 'utf8'))
    expect(raw.accounts.find((a: { id: number }) => a.id === 1).enabled).toBe(false)
    expect(raw.accounts.find((a: { id: number }) => a.id === 2)).not.toHaveProperty('enabled')

    const get = await handlers['accounts:get']() as AccountsResult
    expect(get.accounts?.find((a) => a.id === 1)?.enabled).toBe(false)
  })
})
