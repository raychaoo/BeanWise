import { _electron as electron, expect, test } from '@playwright/test'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

test('应用启动并渲染主窗口', async () => {
  const app = await electron.launch({ args: launchArgs })
  const win = await app.firstWindow()

  await expect(win).toHaveTitle('BeanWise')
  await expect(win.getByRole('heading', { name: 'BeanWise' })).toBeVisible()
  // preload 白名单 API 已注入渲染进程
  await expect(win.locator('#preload-app-name')).toHaveText('BeanWise')

  await app.close()
})
