/**
 * 每个工作目录一份 Git 同步元数据。repoUrl/lastSyncAt 属于账本仓库，
 * 因此放在 <workspace>/.beanwise 下，而不是应用全局 userData。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SyncConfig } from '../shared/ipc'
import type { SyncConfigStore } from './token-store'

interface SyncConfigFile {
  sync?: SyncConfig
}

export class JsonSyncConfigStore implements SyncConfigStore {
  constructor(private readonly filePath: string) {}

  load(): SyncConfig | null {
    try {
      if (!existsSync(this.filePath)) return null
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as SyncConfigFile
      return raw.sync ?? null
    } catch {
      return null
    }
  }

  save(config: SyncConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ sync: config }, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  clear(): void {
    const config = this.load()
    if (!config) return
    writeFileSync(this.filePath, JSON.stringify({}, null, 2), 'utf8')
  }
}
