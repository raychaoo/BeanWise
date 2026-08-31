import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { dirname } from 'node:path'
import { waitForLedgerReady, cleanupFixture, createFixtureCopy } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

/**
 * 批次 D 起指标卡断言需要真实账本数据：smoke 自建临时账本（同 ledger-index/reports 范式），
 * 不再依赖全局 electron-store 默认工作目录（总览 DoD「spec 自建临时账本」口径）。
 */
async function activateWorkspace(win: Page, ledgerPath: string): Promise<void> {
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  await waitForLedgerReady(win)
  await win.reload()
}

test('应用启动并渲染主窗口（总览默认选中 + 四页骨架可用）', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({ args: launchArgs })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    await expect(win).toHaveTitle('BeanWise')
    // 批次 D Task 7：默认路由 = 总览，菜单「总览」默认选中
    await expect(win.getByRole('menuitem', { name: '总览' })).toHaveClass(/ant-menu-item-selected/)
    // 指标卡行随数据加载渲染（fixture 5 entries → 余额非空，卡片而非整页空态）
    await expect(win.getByText('总资产')).toBeVisible()
    await expect(win.getByText('本月收支')).toBeVisible()

    // 新页面对账/账户可达（菜单项可见 + 页面内容渲染）
    await expect(win.getByRole('menuitem', { name: '对账' })).toBeVisible()
    await expect(win.getByRole('menuitem', { name: '账户' })).toBeVisible()
    await win.getByRole('menuitem', { name: '对账' }).click()
    await expect(win.getByRole('tab', { name: '科目余额表' })).toBeVisible()
    await win.getByRole('menuitem', { name: '账户' }).click()
    await expect(win.getByText('科目管理')).toBeVisible()

    // 菜单「录入」路由页（ProForm 提交按钮可见即 preload 白名单链路可用）
    await win.getByRole('menuitem', { name: '录入' }).click()
    await expect(win.getByRole('button', { name: '写入账本' })).toBeVisible()

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})
