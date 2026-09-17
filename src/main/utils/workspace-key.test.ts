import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workspaceStorageKey } from './workspace-key'

/**
 * 这个键是 PAT 与 GitHub 识别缓存的**共同域**（见模块头注释）。它一旦不稳，
 * 「换账本目录」就会串用上一个目录的凭据/身份——是新账本首个提交挂错人的根因。
 */
describe('workspaceStorageKey', () => {
  it('同一目录写成相对/绝对 → 同一个键', () => {
    expect(workspaceStorageKey('ledger-a')).toBe(workspaceStorageKey(resolve('ledger-a')))
  })

  it('大小写不同 → 同一个键（Windows 盘符与目录名大小写不敏感）', () => {
    const dir = join(tmpdir(), 'BeanWiseCaseDir')
    expect(workspaceStorageKey(dir.toUpperCase())).toBe(workspaceStorageKey(dir))
    expect(workspaceStorageKey(dir.toLowerCase())).toBe(workspaceStorageKey(dir))
  })

  it('不同目录 → 不同键（隔离的本意）', () => {
    expect(workspaceStorageKey(join(tmpdir(), 'ledger-a'))).not.toBe(workspaceStorageKey(join(tmpdir(), 'ledger-b')))
  })
})
