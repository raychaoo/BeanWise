import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountsResult } from '../shared/ipc'
import { JsonAccountConfigStore } from './account-config-store'
import { normalizeAccounts, registerAccountHandlers } from './ipc-handlers-accounts'
import type { IpcRegistrar } from './ipc-handlers'

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
})
