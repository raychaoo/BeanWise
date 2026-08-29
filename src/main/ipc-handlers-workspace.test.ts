import { describe, expect, it } from 'vitest'
import { registerWorkspaceHandlers, type WorkspaceDeps } from './ipc-handlers-workspace'
import type { WorkspaceStore } from './workspace-store'

function createMockStore(recents: string[]): WorkspaceStore {
  return {
    loadCurrent: () => recents[0] ?? null,
    setCurrent: () => {},
    clearCurrent: () => {},
    loadRecents: () => recents,
    addRecent: () => {}
  }
}

function registerWithStore(store: WorkspaceStore): Record<string, (...args: unknown[]) => unknown> {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const deps: WorkspaceDeps = {
    store,
    showFolderDialog: async () => ({ canceled: true, filePaths: [] }),
    onWorkspaceChanged: () => {},
    getGit: () => null
  }
  registerWorkspaceHandlers(
    { handle: (channel, listener) => { handlers[channel] = listener as (...args: unknown[]) => unknown } },
    deps
  )
  return handlers
}

describe('workspace:recents IPC（批次 C）', () => {
  it('无入参调用，返回 store.loadRecents() 结果（最新在前）', async () => {
    const recents = ['F:\\BeanWiseData\\test', 'F:\\BeanWiseData\\demo']
    const handlers = registerWithStore(createMockStore(recents))

    expect(handlers['workspace:recents']).toBeDefined()
    const result = (await handlers['workspace:recents']()) as string[]
    expect(result).toEqual(recents)
    expect(result[0]).toBe('F:\\BeanWiseData\\test')
  })

  it('无最近记录 → 空数组', async () => {
    const handlers = registerWithStore(createMockStore([]))
    const result = (await handlers['workspace:recents']()) as string[]
    expect(result).toEqual([])
  })
})
