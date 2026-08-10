/**
 * M6：PAT 与同步配置存储。PAT 经 safeStorage 加密后 base64 存 electron-store；
 * 单测/CI 注入内存实现（ElectronTokenStore import electron → 不可进 vitest node 环境）。
 */
import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { SyncConfig } from '../shared/ipc'

export interface TokenStore {
  load(): string | null
  save(pat: string): void
  clear(): void
}

export interface SyncConfigStore {
  load(): SyncConfig | null
  save(config: SyncConfig): void
  clear(): void
}

/** 主进程组装层实现（main/index.ts 使用；safeStorage 不可用时 save 抛中文 Error） */
export class ElectronTokenStore implements TokenStore {
  private readonly store = new Store<{ pat?: string }>({ name: 'sync-tokens', defaults: {} })
  load(): string | null {
    const enc = this.store.get('pat')
    if (!enc || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }
  save(pat: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法安全存储 PAT')
    this.store.set('pat', safeStorage.encryptString(pat).toString('base64'))
  }
  clear(): void { this.store.delete('pat') }
}

export class ElectronConfigStore implements SyncConfigStore {
  private readonly store = new Store<{ sync?: SyncConfig }>({ name: 'sync-config', defaults: {} })
  load(): SyncConfig | null { return this.store.get('sync') ?? null }
  save(config: SyncConfig): void { this.store.set('sync', config) }
  clear(): void { this.store.delete('sync') }
}
