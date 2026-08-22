/**
 * E2E fixture 副本工具（M4）：main.beancount 副本 → 临时文件。
 * 绿灯链路对账本做写入断言，必须用副本保护 fixture 原文件。
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const FIXTURE_SOURCE = resolve('python/tests/fixtures/main.beancount')

/** 复制 fixture 到临时目录，返回副本路径（5 entries 基线） */
export function createFixtureCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beanwise-e2e-'))
  const target = join(dir, 'main.beancount')
  copyFileSync(FIXTURE_SOURCE, target)
  return target
}

/** 清理副本所在临时目录 */
export function cleanupFixture(ledgerPath: string): void {
  // Windows 下 Electron 退出与 SQLite 关闭可能短暂竞态，给句柄释放留出重试窗口。
  rmSync(dirname(ledgerPath), { recursive: true, force: true, maxRetries: 120, retryDelay: 250 })
}
