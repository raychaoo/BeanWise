import { beforeEach, expect, it, vi } from 'vitest'

// 同 sync.test.ts：antd 在 node 环境不可直接求值，message 打桩；
// window.beanwise 由各用例 stubBeanwise 注入。
const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useLedgerStore } from './ledger'

function stubBeanwise(overrides: Partial<{
  getAccountConfig: ReturnType<typeof vi.fn>
  listLedgerAccounts: ReturnType<typeof vi.fn>
  listLedgerCounterparties: ReturnType<typeof vi.fn>
}> = {}): void {
  vi.stubGlobal('window', {
    beanwise: {
      getAccountConfig: vi.fn().mockResolvedValue({ ok: true, accounts: [] }),
      listLedgerAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
      listLedgerCounterparties: vi.fn().mockResolvedValue({ counterparties: [] }),
      ...overrides
    }
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useLedgerStore.setState({
    status: null, entries: [], total: 0, accountOptions: [], accountValues: [],
    counterpartyValues: [], counterpartyOptions: [], loading: false, error: null,
    editorContent: null, editorOriginal: null, editorFingerprint: null,
    editorLoaded: false, editorMissing: false, editorSaving: false, editorConflict: null
  })
  Object.values(message).forEach((m) => m.mockClear())
})

it('mergeAccountOptions：停用（enabled=false）配置账户不进下拉，其余配置 + 历史账户保留', async () => {
  stubBeanwise({
    getAccountConfig: vi.fn().mockResolvedValue({
      ok: true,
      accounts: [
        { id: 1, name: '银行卡', value: 'Assets:Bank' },
        { id: 2, name: '旧卡', value: 'Assets:Old', enabled: false },
        { id: 3, name: '餐饮', value: 'Expenses:Food' }
      ]
    }),
    listLedgerAccounts: vi.fn().mockResolvedValue({ accounts: ['Assets:Bank', 'Liabilities:Card'] })
  })

  await useLedgerStore.getState().loadAccounts()

  const { accountOptions, accountValues } = useLedgerStore.getState()
  const values = accountOptions.map((o) => o.value)
  expect(values).toContain('Assets:Bank')
  expect(values).toContain('Expenses:Food')
  // 账本中存在但账户库没有的账户（历史交易产生）无停用载体，始终出现
  expect(values).toContain('Liabilities:Card')
  expect(values).not.toContain('Assets:Old')
  expect(accountOptions.find((o) => o.value === 'Liabilities:Card')?.label).toBe('Liabilities:Card')
  expect(accountValues).not.toContain('Assets:Old')
})

it('mergeAccountOptions：停用配置账户即使账本有历史交易也不回灌下拉（停用 = 录入不可选）', async () => {
  stubBeanwise({
    getAccountConfig: vi.fn().mockResolvedValue({
      ok: true,
      accounts: [{ id: 1, name: '旧卡', value: 'Assets:Old', enabled: false }]
    }),
    listLedgerAccounts: vi.fn().mockResolvedValue({ accounts: ['Assets:Old'] })
  })

  await useLedgerStore.getState().loadAccounts()

  const values = useLedgerStore.getState().accountOptions.map((o) => o.value)
  expect(values).toEqual([])
})

it('counterpartyValues / counterpartyOptions：往来类账户只认启用条目的标志，候选来自历史（ADR 23）', async () => {
  stubBeanwise({
    getAccountConfig: vi.fn().mockResolvedValue({
      ok: true,
      accounts: [
        { id: 1, name: '借出', value: 'Assets:Receivables:Lend', counterparty: true },
        { id: 2, name: '停用的借出', value: 'Assets:Receivables:Old', counterparty: true, enabled: false },
        { id: 3, name: '银行卡', value: 'Assets:Bank' },
        // 账本历史账户无账户库载体，即便有 counterparty 缺省也不该被当作往来类
        { id: 4, name: '脏值', value: 'Assets:Dirty', counterparty: 'yes' as unknown as boolean }
      ]
    }),
    listLedgerCounterparties: vi.fn().mockResolvedValue({ counterparties: ['李志全', '王五'] })
  })

  await useLedgerStore.getState().loadAccounts()

  const s = useLedgerStore.getState()
  expect(s.counterpartyValues).toEqual(['Assets:Receivables:Lend'])
  expect(s.counterpartyOptions).toEqual(['李志全', '王五'])
})
