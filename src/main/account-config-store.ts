/**
 * 每个工作目录一份通用账户库。账户属于当前账本工作区，
 * 因此保存在 <workspace>/.beanwise/accounts.json。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AccountEntry } from '../shared/ipc'

interface AccountConfigFile {
  accounts?: AccountEntry[]
}

export class JsonAccountConfigStore {
  constructor(private readonly filePath: string) {}

  load(): AccountEntry[] {
    try {
      if (!existsSync(this.filePath)) return []
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as AccountConfigFile
      if (!Array.isArray(raw.accounts)) return []
      return raw.accounts.filter(
        (a): a is AccountEntry =>
          typeof a === 'object' && a !== null &&
          typeof (a as AccountEntry).id === 'number' &&
          typeof (a as AccountEntry).name === 'string' &&
          typeof (a as AccountEntry).value === 'string'
      )
    } catch {
      return []
    }
  }

  save(accounts: AccountEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  /** 返回下一个可用自增 id */
  nextId(): number {
    const accounts = this.load()
    return accounts.length > 0 ? Math.max(...accounts.map((a) => a.id)) + 1 : 1
  }
}
