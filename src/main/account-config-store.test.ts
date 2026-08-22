import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonAccountConfigStore } from './account-config-store'

describe('JsonAccountConfigStore', () => {
  const dirs: string[] = []

  function createStore(): JsonAccountConfigStore {
    const dir = mkdtempSync(join(tmpdir(), 'beanwise-account-config-'))
    dirs.push(dir)
    return new JsonAccountConfigStore(join(dir, '.beanwise', 'accounts.json'))
  }

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('未配置返回空；保存后读取同一份账户', () => {
    const store = createStore()
    expect(store.load()).toEqual([])

    store.save([
      { id: 1, name: '银行卡', value: 'Assets:Bank', description: '日常消费' },
      { id: 2, name: '餐饮', value: 'Expenses:Food', description: '吃饭' }
    ])
    expect(store.load()).toEqual([
      { id: 1, name: '银行卡', value: 'Assets:Bank', description: '日常消费' },
      { id: 2, name: '餐饮', value: 'Expenses:Food', description: '吃饭' }
    ])
  })

  it('损坏的配置文件降级为空，不阻断录入页', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beanwise-account-config-'))
    dirs.push(dir)
    const path = join(dir, '.beanwise', 'accounts.json')
    mkdirSync(join(dir, '.beanwise'), { recursive: true })
    writeFileSync(path, '{broken-json', 'utf8')

    expect(new JsonAccountConfigStore(path).load()).toEqual([])
  })
})
