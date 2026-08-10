/**
 * M6-T6 审查修复验证（临时 spec，验收后可删）：
 * C-1 Critical——merged 编辑器容器曾随 conflict 早退条件渲染，空依赖创建 effect
 * 在挂载时 bail（conflict===null）后永不重跑 → 编辑器恒无法创建。
 * 本用例走真实冲突链路（Task 3 git-test-server 裸仓 + 场景 C）验证：
 * 冲突 → 「合并」菜单 → 双 Diff 可见 + merged 编辑器可见 → 采用远端 → 内容更新 → 完成合并。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { createBareRepo, seedRemoteInit, startGitServer } from '../src/main/git-test-server'
import { cleanupFixture, createFixtureCopy } from './fixtures/setup'

const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

test('M6-T6 冲突视图：merged 编辑器无条件渲染 + 采用远端 + 完成合并全链路', async () => {
  test.setTimeout(120_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  try {
    // 远端内容 = 本地 fixture + 追加合法交易（场景 C：unrelated + 内容不一致 → conflict，base=''）
    const remoteContent =
      readFileSync(ledgerPath, 'utf8') +
      '\n2026-08-09 * "远端修改" "M6T6"\n  Expenses:Food  12.00 CNY\n  Assets:Bank:CNB  -12.00 CNY\n'
    await seedRemoteInit(server.url, remoteContent)

    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()

    // 清掉可能残留的同步配置（electron-store 跨测试持久化），重载回未配置态
    await win.evaluate(() => window.beanwise.clearSync())
    await win.reload()
    await expect(win.getByRole('button', { name: '配置同步' })).toBeVisible()

    // 1. 配置同步 → 场景 C 冲突 → store 接管
    await win.getByRole('button', { name: '配置同步' }).click()
    await win.getByPlaceholder('https://github.com/yourname/beanwise').fill(server.url)
    await win.getByPlaceholder('ghp_...').fill('test-pat')
    await win.getByRole('button', { name: /并同步/ }).click()
    await expect(win.locator('.ant-message')).toContainText('请在三路合并视图处理')

    // 2. 「合并」菜单项出现 → 进入冲突视图（冲突时 configure 返回 false，设置弹窗保持打开——先 ESC 关闭）
    await expect(win.getByRole('menuitem', { name: '合并' })).toBeVisible()
    await win.keyboard.press('Escape')
    await win.getByRole('menuitem', { name: '合并' }).click()

    // 3. C-1 修复验证：上双 Diff + 下 merged 编辑器均可见（修复前 merged 恒为空框）
    await expect(win.locator('.conflict-diff .monaco-diff-editor')).toBeVisible()
    await expect(win.locator('.conflict-merged .monaco-editor')).toBeVisible()

    // 4. 采用远端 → merged 内容 = 远端（UI 断言：点击 view-line 聚焦后 Ctrl+End 滚到底，追加交易可见）
    await win.getByRole('button', { name: '采用远端' }).click()
    await win.locator('.conflict-merged .view-line').first().click()
    await win.keyboard.press('Control+End')
    await expect(win.locator('.conflict-merged .view-lines')).toContainText('远端修改')

    // 5. 完成合并 → 成功提示 + 冲突消失 + merged 编辑器仍在（无条件渲染，视图保活）
    await win.getByRole('button', { name: '完成合并' }).click()
    await expect(win.locator('.ant-message')).toContainText('冲突已解决并推送')
    await expect(win.getByRole('menuitem', { name: '合并' })).toHaveCount(0)
    await expect(win.locator('.conflict-diff .monaco-diff-editor')).toHaveCount(0)
    await expect(win.locator('.conflict-merged .monaco-editor')).toBeVisible()

    // 6. 内容地面真相：resolve 写入的 merged = 采用远端后的 theirs（含追加交易）——
    //    若 采用远端 未生效（merged 仍为 ours），此断言失败，整个链路即判假
    expect(readFileSync(ledgerPath, 'utf8')).toContain('远端修改')

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})
