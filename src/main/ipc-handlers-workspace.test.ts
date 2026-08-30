import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerWorkspaceHandlers, type WorkspaceDeps } from './ipc-handlers-workspace'
import type { WorkspaceStore } from './workspace-store'

function createMockStore(recents: string[]): WorkspaceStore {
  return {
    loadCurrent: () => recents[0] ?? null,
    setCurrent: () => {},
    clearCurrent: () => {},
    loadRecents: () => recents,
    addRecent: () => {},
    removeRecent: () => {},
    replaceRecent: () => {}
  }
}

function registerWithStore(store: WorkspaceStore, onWorkspaceChanged: (path: string) => void = () => {}): Record<string, (...args: unknown[]) => unknown> {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const deps: WorkspaceDeps = {
    store,
    showFolderDialog: async () => ({ canceled: true, filePaths: [] }),
    onWorkspaceChanged,
    getGit: () => null
  }
  registerWorkspaceHandlers(
    { handle: (channel, listener) => { handlers[channel] = listener as (...args: unknown[]) => unknown } },
    deps
  )
  return handlers
}

/** 可变内存 store：真实反映 removeRecent/replaceRecent 语义（批次 H handler 联动验证用） */
function createFakeStore(initialCurrent: string | null, initialRecents: string[]): WorkspaceStore {
  let current = initialCurrent
  let recents = [...initialRecents]
  return {
    loadCurrent: () => current,
    setCurrent: (p) => { current = p; recents = [p, ...recents.filter((x) => x !== p)] },
    clearCurrent: () => { current = null },
    loadRecents: () => [...recents],
    addRecent: (p) => { recents = [p, ...recents.filter((x) => x !== p)] },
    removeRecent: (p) => {
      recents = recents.filter((x) => x !== p)
      if (current === p) current = null
    },
    replaceRecent: (oldPath, newPath) => {
      const idx = recents.indexOf(oldPath)
      if (idx >= 0) recents[idx] = newPath
      if (current === oldPath) current = newPath
    }
  }
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

describe('workspace rename/archive/delete IPC（批次 H，白名单 + 磁盘操作）', () => {
  let parent: string
  let dirA: string
  let dirB: string
  let dirC: string
  const parents: string[] = []

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'beanwise-ws-mgmt-'))
    parents.push(parent)
    ;[dirA, dirB, dirC] = ['a', 'b', 'c'].map((name) => {
      const dir = join(parent, name)
      mkdirSync(dir)
      writeFileSync(join(dir, 'main.beancount'), '', 'utf8')
      return dir
    })
  })

  afterEach(() => {
    while (parents.length) rmSync(parents.pop()!, { recursive: true, force: true })
  })

  /** 固定 fixture：current=a，recents=[a,b,c]（磁盘上三个目录均存在） */
  function setup(current: string | null = dirA): { store: WorkspaceStore; handlers: Record<string, (...args: unknown[]) => unknown>; onChanged: ReturnType<typeof vi.fn> } {
    const store = createFakeStore(current, [dirA, dirB, dirC])
    const onChanged = vi.fn()
    const handlers = registerWithStore(store, onChanged)
    return { store, handlers, onChanged }
  }

  it('rename 非 current：磁盘改名 + recents 原位替换 + 不触发 onWorkspaceChanged', async () => {
    const { store, handlers, onChanged } = setup()
    const result = (await handlers['workspace:rename'](undefined, { path: dirB, newName: '新账本B' })) as { ok: boolean; newPath?: string }

    expect(result.ok).toBe(true)
    const newPath = join(parent, '新账本B')
    expect(result.newPath).toBe(newPath)
    expect(existsSync(dirB)).toBe(false)
    expect(existsSync(join(newPath, 'main.beancount'))).toBe(true)
    expect(store.loadRecents()).toEqual([dirA, newPath, dirC])
    expect(store.loadCurrent()).toBe(dirA)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('rename current → 拒绝（当前账本 index.db 被运行时占用，Windows 下 renameSync 必败）', async () => {
    const { store, handlers, onChanged } = setup()
    const result = (await handlers['workspace:rename'](undefined, { path: dirA, newName: 'A2' })) as { ok: boolean; message?: string }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('当前')
    expect(existsSync(dirA)).toBe(true)
    expect(store.loadCurrent()).toBe(dirA)
    expect(store.loadRecents()).toEqual([dirA, dirB, dirC])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('rename 同父目录已存在重名 → 拒绝且磁盘不变', async () => {
    const { store, handlers } = setup()
    const result = (await handlers['workspace:rename'](undefined, { path: dirB, newName: 'c' })) as { ok: boolean; message?: string }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('已存在')
    expect(existsSync(dirB)).toBe(true)
    expect(store.loadRecents()).toEqual([dirA, dirB, dirC])
  })

  it.each(['../evil', 'sub\\dir', 'sub/dir', 'a.b', '', 'x'.repeat(101)])('rename 非法 newName（%j）→ 拒绝且磁盘不变', async (newName) => {
    const { handlers } = setup()
    const result = (await handlers['workspace:rename'](undefined, { path: dirB, newName })) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(existsSync(dirB)).toBe(true)
  })

  it('rename 白名单外路径 → 拒绝（防目录穿越）', async () => {
    const outside = join(parent, 'not-registered')
    mkdirSync(outside)
    const { store, handlers } = setup()
    const result = (await handlers['workspace:rename'](undefined, { path: outside, newName: 'x' })) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(existsSync(outside)).toBe(true)
    expect(store.loadRecents()).toEqual([dirA, dirB, dirC])
  })

  it('archive 非 current：移动到 <parent>/.beanwise-archive/<basename>-<时间戳>，recents 清除', async () => {
    const { store, handlers } = setup()
    const result = (await handlers['workspace:archive'](undefined, { path: dirC })) as { ok: boolean; newPath?: string }

    expect(result.ok).toBe(true)
    const archiveDir = join(parent, '.beanwise-archive')
    expect(existsSync(archiveDir)).toBe(true)
    const moved = result.newPath!
    expect(moved.startsWith(join(archiveDir, 'c-'))).toBe(true)
    expect(/c-\d{14}$/.test(moved)).toBe(true)
    expect(existsSync(dirC)).toBe(false)
    expect(existsSync(join(moved, 'main.beancount'))).toBe(true)
    expect(store.loadRecents()).toEqual([dirA, dirB])
    expect(store.loadCurrent()).toBe(dirA)
  })

  it('archive current → 拒绝（同 rename，运行时占用）', async () => {
    const { store, handlers } = setup()
    const result = (await handlers['workspace:archive'](undefined, { path: dirA })) as { ok: boolean; message?: string }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('当前')
    expect(existsSync(dirA)).toBe(true)
    expect(store.loadCurrent()).toBe(dirA)
    expect(store.loadRecents()).toEqual([dirA, dirB, dirC])
  })

  it('archive 白名单外路径 → 拒绝', async () => {
    const outside = join(parent, 'not-registered')
    mkdirSync(outside)
    const { handlers } = setup()
    const result = (await handlers['workspace:archive'](undefined, { path: outside })) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  it('delete 非 current：rmSync 递归删除 + recents 清除', async () => {
    const { store, handlers } = setup()
    const result = (await handlers['workspace:delete'](undefined, { path: dirC })) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(existsSync(dirC)).toBe(false)
    expect(store.loadRecents()).toEqual([dirA, dirB])
    expect(store.loadCurrent()).toBe(dirA)
  })

  it('delete current → 拒绝（红线），磁盘与 store 均不变', async () => {
    const { store, handlers } = setup()
    const result = (await handlers['workspace:delete'](undefined, { path: dirA })) as { ok: boolean; message?: string }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('当前')
    expect(existsSync(dirA)).toBe(true)
    expect(store.loadCurrent()).toBe(dirA)
    expect(store.loadRecents()).toEqual([dirA, dirB, dirC])
  })

  it('delete 白名单外路径 → 拒绝', async () => {
    const outside = join(parent, 'not-registered')
    mkdirSync(outside)
    const { handlers } = setup()
    const result = (await handlers['workspace:delete'](undefined, { path: outside })) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  it('三通道入参缺 path / 非 string → 拒绝', async () => {
    const { handlers } = setup()
    for (const channel of ['workspace:rename', 'workspace:archive', 'workspace:delete']) {
      const result = (await handlers[channel](undefined, {})) as { ok: boolean }
      expect(result.ok).toBe(false)
    }
  })

  it('白名单内但目录已不存在（如被外部移动）→ 拒绝并提示', async () => {
    const ghost = join(parent, 'ghost')
    const store = createFakeStore(dirA, [dirA, ghost])
    const h = registerWithStore(store)
    const result = (await h['workspace:archive'](undefined, { path: ghost })) as { ok: boolean; message?: string }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('不存在')
    expect(existsSync(ghost)).toBe(false)
  })
})
