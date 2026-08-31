/**
 * E2E fixture 副本工具（M4）：main.beancount 副本 → 临时文件。
 * 绿灯链路对账本做写入断言，必须用副本保护 fixture 原文件。
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Page } from '@playwright/test'

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

/**
 * 等索引就绪再 reload（批次 G 回归修复）：workspace:open 的索引刷新是 fire-and-forget，
 * 立即 reload 会让 reload 后触发的 loadAccounts/ledger 读取拿到空 postings/ledger_meta
 * （账户树空、运营货币空、余额空）——时序不稳导致 e2e 偶发挂起。轮询 ledger status 直到
 * 索引状态落定（status ok/missing）再 reload，各 spec 的 activateWorkspace 统一调用。
 */
export async function waitForLedgerReady(win: Page): Promise<void> {
  await win.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const s = await window.beanwise.getLedgerStatus()
      if (s && (s.status === 'ok' || s.status === 'missing')) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('等待索引就绪超时')
  })
}
