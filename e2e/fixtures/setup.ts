/**
 * E2E fixture 副本工具（M4）：main.beancount 副本 → 临时文件。
 * 绿灯链路对账本做写入断言，必须用副本保护 fixture 原文件。
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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

/**
 * 预置账户库配置（`<workspace>/.beanwise/accounts.json`）——须在 `activateWorkspace` 前写入，
 * 之后渲染端 reload 才能读到（账户中文名映射依赖它）。
 */
export function seedAccountConfig(ledgerPath: string, accounts: unknown[]): void {
  const dir = join(dirname(ledgerPath), '.beanwise')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ accounts }, null, 2), 'utf8')
}

/**
 * 清理副本所在临时目录。
 *
 * Windows 下 Electron 退出与 SQLite 句柄释放存在短暂竞态，删除要留重试窗口。**必须用异步 `rm`**：
 * Node 的 `rmSync` 在 Windows 上对 EBUSY **不做重试**（实测持锁 3s、给足 30×100ms 预算，
 * `rmSync` 2ms 即抛 EBUSY；同一场景 `rm` 等到 2.87s 锁释放后成功）——`maxRetries` 配在同步
 * API 上形同虚设，这正是本函数此前的隐患：以为有 30 分钟重试窗口，实际是立刻抛出。
 * 另注意必须取自 `node:fs/promises`：回调式 `fs.rm` **不是** promise-capable（省略回调时
 * 返回 undefined，随后异步崩 `TypeError: callback is not a function`）。
 *
 * 重试为**线性**退避（第 n 次失败后等 n × retryDelay），故上限即最坏耗时：
 * 100 × 30×31/2 ≈ 47 秒——足够覆盖句柄释放竞态，也不会让失败的测试久等。
 *
 * 清理失败只告警不抛出：临时目录残留是小事，若让它抛出会**顶掉真正的断言失败**，
 * 把「为什么挂」变成「删不掉目录」。
 */
export async function cleanupFixture(ledgerPath: string): Promise<void> {
  try {
    await rm(dirname(ledgerPath), { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
  } catch (err) {
    console.warn(`[e2e] 临时目录清理失败（不影响测试结论）：${dirname(ledgerPath)} — ${String(err)}`)
  }
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
