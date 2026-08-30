/**
 * WorkspaceStore 扩展（批次 H）：removeRecent / replaceRecent。
 * electron-store mock 为内存对象（node 测试环境无 app.getPath），验证 recents 原位操作与 current 联动。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron-store', () => {
  class MemoryStore {
    private data: Record<string, unknown> = {}
    get(key: string): unknown { return this.data[key] }
    set(key: string, value: unknown): void { this.data[key] = value }
    delete(key: string): void { delete this.data[key] }
  }
  return { default: MemoryStore }
})

import { ElectronWorkspaceStore } from './workspace-store'

describe('ElectronWorkspaceStore removeRecent/replaceRecent（批次 H）', () => {
  let store: ElectronWorkspaceStore

  beforeEach(() => {
    store = new ElectronWorkspaceStore()
    store.clearCurrent()
  })

  /** 通过公开 API 预置状态：current=path 且 recents 置顶 */
  function seed(current: string | null, recents: string[]): void {
    store.clearCurrent()
    for (const p of [...recents].reverse()) store.addRecent(p)
    if (current) store.setCurrent(current)
  }

  it('removeRecent 移除指定项且保持顺序，current 不受影响', () => {
    seed('F:\\BeanWiseData\\a', ['F:\\BeanWiseData\\a', 'F:\\BeanWiseData\\b', 'F:\\BeanWiseData\\c'])
    store.removeRecent('F:\\BeanWiseData\\b')
    expect(store.loadRecents()).toEqual(['F:\\BeanWiseData\\a', 'F:\\BeanWiseData\\c'])
    expect(store.loadCurrent()).toBe('F:\\BeanWiseData\\a')
  })

  it('removeRecent 移除 current 时同时清空 current', () => {
    seed('F:\\BeanWiseData\\a', ['F:\\BeanWiseData\\a', 'F:\\BeanWiseData\\b'])
    store.removeRecent('F:\\BeanWiseData\\a')
    expect(store.loadRecents()).toEqual(['F:\\BeanWiseData\\b'])
    expect(store.loadCurrent()).toBeNull()
  })

  it('replaceRecent 原位替换（不改变顺序），current 不受影响', () => {
    seed(null, []) // 无 current 场景
    store.clearCurrent()
    for (const p of ['F:\\BeanWiseData\\a', 'F:\\BeanWiseData\\b', 'F:\\BeanWiseData\\c'].reverse()) store.addRecent(p)
    store.replaceRecent('F:\\BeanWiseData\\b', 'F:\\BeanWiseData\\B2')
    expect(store.loadRecents()).toEqual(['F:\\BeanWiseData\\a', 'F:\\BeanWiseData\\B2', 'F:\\BeanWiseData\\c'])
    expect(store.loadCurrent()).toBeNull()
  })

  it('replaceRecent 替换 current 时同步更新 current（原位，不移到队首）', () => {
    seed('F:\\BeanWiseData\\a', ['F:\\BeanWiseData\\a', 'F:\\BeanWiseData\\b'])
    store.replaceRecent('F:\\BeanWiseData\\a', 'F:\\BeanWiseData\\A2')
    expect(store.loadRecents()).toEqual(['F:\\BeanWiseData\\A2', 'F:\\BeanWiseData\\b'])
    expect(store.loadCurrent()).toBe('F:\\BeanWiseData\\A2')
  })

  it('replaceRecent 路径不在 recents 中时无副作用', () => {
    seed('F:\\BeanWiseData\\a', ['F:\\BeanWiseData\\a'])
    store.replaceRecent('F:\\BeanWiseData\\ghost', 'F:\\BeanWiseData\\x')
    expect(store.loadRecents()).toEqual(['F:\\BeanWiseData\\a'])
    expect(store.loadCurrent()).toBe('F:\\BeanWiseData\\a')
  })
})
