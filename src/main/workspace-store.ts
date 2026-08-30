/**
 * 工作目录持久化。当前路径 + 最近打开列表存 electron-store；
 * 渲染进程不直接接触路径（主进程持有，防目录穿越）。
 */

import Store from 'electron-store'

export interface WorkspaceStore {
  loadCurrent(): string | null
  setCurrent(path: string): void
  clearCurrent(): void
  loadRecents(): string[]
  addRecent(path: string): void
  /** 从 recents 移除；若是 current 同时清空 current（批次 H 归档/删除） */
  removeRecent(path: string): void
  /** recents 原位替换；若是 current 同时更新 current（批次 H 重命名） */
  replaceRecent(oldPath: string, newPath: string): void
}

const MAX_RECENTS = 10

export class ElectronWorkspaceStore implements WorkspaceStore {
  private readonly store = new Store<{ current?: string; recents?: string[] }>({ name: 'workspace', defaults: {} })

  loadCurrent(): string | null { return this.store.get('current') ?? null }
  setCurrent(path: string): void { this.store.set('current', path); this.addRecent(path) }
  clearCurrent(): void { this.store.delete('current') }
  loadRecents(): string[] { return this.store.get('recents') ?? [] }
  addRecent(path: string): void {
    const list = (this.store.get('recents') ?? []).filter((p) => p !== path)
    list.unshift(path)
    this.store.set('recents', list.slice(0, MAX_RECENTS))
  }

  removeRecent(path: string): void {
    this.store.set('recents', this.loadRecents().filter((p) => p !== path))
    if (this.loadCurrent() === path) this.clearCurrent()
  }

  replaceRecent(oldPath: string, newPath: string): void {
    const list = this.loadRecents()
    const idx = list.indexOf(oldPath)
    if (idx >= 0) {
      list[idx] = newPath
      this.store.set('recents', list)
    }
    // 不走 setCurrent：原位替换语义，不得把新路径挪到队首
    if (this.loadCurrent() === oldPath) this.store.set('current', newPath)
  }
}
