/**
 * M8 E2E（T7）：升级演练（绿灯「升级演练」）——BEANWISE_UPDATE_FEED_URL 注入
 * 进程内 mock 更新源 → Header「更新」→ Modal「检查更新」→ 发现新版本 9.9.9 → 下载完成。
 * 断言到 downloaded 为止，不触发安装（quitAndInstall 会替换运行中的应用，安装环节留首版人工演练）。
 *
 * 环境事实（同 ai-entry.spec.ts）：antd Button autoInsertSpaceInButton——两字中文按钮
 * 可访问名含空格，「更新」以 /更\s*新/ 匹配；App.tsx 多视图常驻挂载，Modal 内容作用域
 * .ant-modal-body。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startUpdateServer } from './fixtures/update'
import { createFixtureCopy, cleanupFixture } from './fixtures/setup'

const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

/**
 * M8-T7 实测修正：electron-updater 按文件 sha512 复用已下载安装包（updaterCacheDirName 缓存目录），
 * 首轮 run 后二次 run 秒级跳过下载——available 态窗口消失，「发现新版本」断言必然错过。
 * 每次启动前清缓存（路径镜像 electron-updater getAppCacheDir + dev-app-update.yml 的
 * updaterCacheDirName），保证每轮都真实走「检查→下载」。
 */
function clearUpdaterCache(): void {
  const base =
    process.platform === 'win32'
      ? (process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches')
        : (process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'))
  try {
    rmSync(join(base, 'beanwise-updater'), { recursive: true, force: true })
  } catch {
    // 缓存清理为尽力而为：失败则下载命中缓存、available 态断言可能错过（用例会明确失败）
  }
}

test('M8 升级演练：检查到新版本 → 下载 → downloaded', async () => {
  test.setTimeout(180_000)
  clearUpdaterCache()
  const update = await startUpdateServer()
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath, BEANWISE_UPDATE_FEED_URL: update.url }
    })
    const win = await app.firstWindow()

    await win.getByRole('button', { name: /更\s*新/ }).click()
    await expect(win.locator('.ant-modal-body')).toContainText('当前版本：v0.1.0')
    await win.getByRole('button', { name: /检查更新/ }).click()

    // 发现新版本（mock 源 9.9.9 > 0.1.0）
    await expect(win.locator('.ant-modal-body')).toContainText('发现新版本 v9.9.9', { timeout: 60_000 })
    // 下载完成（本地 mock 源，秒级）
    await expect(win.locator('.ant-modal-body')).toContainText('下载完成', { timeout: 120_000 })
    // 不触发安装：断言「立即安装」按钮存在但不点击
    await expect(win.getByRole('button', { name: /立即安装/ })).toBeVisible()

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
    await update.close()
  }
})
