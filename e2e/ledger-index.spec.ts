import { _electron as electron, expect, test } from '@playwright/test'
import { resolve } from 'node:path'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']
// 与 index-builder 测试同源的合法账本 fixture（3 open + 2 交易 = 5 entries）
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

test('M3 绿灯：刷新索引后条目可见', async () => {
  const app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, BEANWISE_LEDGER_PATH: FIXTURE }
  })
  const win = await app.firstWindow()

  const refreshBtn = win.getByRole('button', { name: '刷新索引' })
  await expect(refreshBtn).toBeVisible()
  await refreshBtn.click()

  // 索引可见：条目数 5、状态 ok、Breakfast 交易在列表中
  await expect(win.locator('#entry-count')).toHaveText('5')
  await expect(win.locator('#index-status')).toHaveText('ok')
  await expect(win.locator('#ledger-entries .entry-list li', { hasText: 'Breakfast' })).toBeVisible()

  await app.close()
})
