import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SyncConfig } from '../shared/ipc'
import { JsonSyncConfigStore } from './workspace-config-store'

describe('JsonSyncConfigStore', () => {
  const dirs: string[] = []

  function createStore(): JsonSyncConfigStore {
    const dir = mkdtempSync(join(tmpdir(), 'beanwise-sync-config-'))
    dirs.push(dir)
    return new JsonSyncConfigStore(join(dir, '.beanwise', 'sync-config.json'))
  }

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('未配置 → null；保存后按工作目录文件读写', () => {
    const store = createStore()
    expect(store.load()).toBeNull()

    const config: SyncConfig = {
      repoUrl: 'https://github.com/a/b',
      branch: 'main',
      adopted: false,
      lastSyncAt: 123,
      lastError: null
    }
    store.save(config)
    expect(store.load()).toEqual(config)
  })

  it('clear 只清空当前目录配置', () => {
    const store = createStore()
    store.save({ repoUrl: 'https://github.com/a/b', branch: 'main' })
    store.clear()
    expect(store.load()).toBeNull()
  })
})
