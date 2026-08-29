import { _electron as electron, expect, test } from '@playwright/test'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

test('应用启动并渲染主窗口', async () => {
  const app = await electron.launch({ args: launchArgs })
  const win = await app.firstWindow()

  await expect(win).toHaveTitle('BeanWise')
  // 批次 A 路由化：默认路由 = 总览占位页（作用域 .ant-result-title，避开 Sider 菜单同名项）
  await expect(win.locator('.ant-result-title')).toContainText('总览')
  // ProLayout 菜单 →「录入」路由页（ProForm 提交按钮可见即 preload 白名单链路可用）
  await win.getByRole('menuitem', { name: '录入' }).click()
  await expect(win.getByRole('button', { name: '写入账本' })).toBeVisible()

  await app.close()
})
