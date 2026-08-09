import { _electron as electron, expect, test } from '@playwright/test'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

test('应用启动并渲染主窗口', async () => {
  const app = await electron.launch({ args: launchArgs })
  const win = await app.firstWindow()

  await expect(win).toHaveTitle('BeanWise')
  await expect(win.getByRole('heading', { name: 'BeanWise' })).toBeVisible()
  // M4 应用壳：默认进入「录入」视图（ProForm 提交按钮可见即 preload 白名单链路可用）
  await expect(win.getByRole('button', { name: '写入账本' })).toBeVisible()

  await app.close()
})
