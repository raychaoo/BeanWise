/**
 * M6：PAT 存储。PAT 按工作目录隔离，经 safeStorage 加密后 base64 存 electron-store；
 * 单测/CI 注入内存实现（本模块 import electron → 不可进 vitest node 环境）。
 */
import Store from 'electron-store'
import { safeStorage } from 'electron'
import { resolve } from 'node:path'
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

/** Windows 盘符大小写和路径分隔符不影响同一个目录的标识 */
function workspaceStorageKey(workspaceDir: string): string {
  return resolve(workspaceDir).toLowerCase()
}

/** 按工作目录隔离的 PAT。密文仍在 userData，避免把凭据文件放进账本仓库。 */
export class ElectronWorkspaceTokenStore implements TokenStore {
  private readonly store = new Store<{ tokens?: Record<string, string> }>({ name: 'sync-tokens', defaults: {} })
  private readonly key: string

  constructor(workspaceDir: string) {
    this.key = workspaceStorageKey(workspaceDir)
  }

  load(): string | null {
    const scoped = this.store.get('tokens')?.[this.key]
    if (!scoped || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(scoped, 'base64'))
  }

  save(pat: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法安全存储 PAT')
    const enc = safeStorage.encryptString(pat).toString('base64')
    const tokens = this.store.get('tokens') ?? {}
    tokens[this.key] = enc
    this.store.set('tokens', tokens)
  }

  clear(): void {
    const tokens = this.store.get('tokens')
    if (!tokens?.[this.key]) return
    delete tokens[this.key]
    this.store.set('tokens', tokens)
  }
}

/** M7：DeepSeek API Key 存储（复刻 PAT 模式：safeStorage 加密 → base64 → electron-store） */
export class ElectronAiTokenStore implements TokenStore {
  private readonly store = new Store<{ apiKey?: string }>({ name: 'ai-tokens', defaults: {} })
  load(): string | null {
    const enc = this.store.get('apiKey')
    if (!enc || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }
  save(apiKey: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法安全存储 API Key')
    this.store.set('apiKey', safeStorage.encryptString(apiKey).toString('base64'))
  }
  clear(): void { this.store.delete('apiKey') }
}
