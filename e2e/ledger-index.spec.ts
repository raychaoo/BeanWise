import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanupFixture, createFixtureCopy } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

// antd InputNumber stringMode 会规范化尾随零（'25.50' → '25.5'，beancount 语义等价）
const ENTRY_BLOCK_RE =
  /\n20\d{2}-\d{2}-\d{2} \* "测试午饭" "M4 E2E"\n  Expenses:Food  25\.5 CNY\n  Assets:Bank:CNB  -25\.5 CNY\n$/

/** E2E 不复用全局工作目录；显式激活临时目录后重载，让渲染端拿到新运行时。 */
async function activateWorkspace(win: Page, ledgerPath: string): Promise<void> {
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  await win.reload()
  await expect(win.getByRole('button', { name: '写入账本' })).toBeVisible()
}

test('M4 绿灯：录入一笔 → 落文件 → 校验 → 索引更新（端到端）', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    // 1. 切「明细」→ 重建索引 → 5 行（含 Breakfast）
    await win.getByRole('menuitem', { name: '明细' }).click()
    await win.getByRole('button', { name: '重建索引' }).click()
    await expect(win.locator('.ant-table-tbody tr')).toHaveCount(5)
    await expect(win.locator('.ant-table-tbody')).toContainText('Breakfast')

    // 2. 切回「录入」填两行：第一行填金额，第二行选账户后留空由系统自动补差。
    await win.getByRole('menuitem', { name: '录入' }).click()
    await win.getByLabel('交易对象').fill('测试午饭')
    await win.getByLabel('说明').fill('M4 E2E')
    await win.getByLabel('账户').nth(0).fill('Expenses:Food')
    await win.getByLabel('金额').nth(0).fill('25.50')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await win.getByLabel('账户').nth(1).fill('Assets:Bank:CNB')
    await win.getByLabel('货币').nth(1).fill('CNY')

    // 3. 提交 → 成功提示 → 明细 5→6，新行含「测试午饭」
    const beforeSize = statSync(ledgerPath).size
    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')
    await win.getByRole('menuitem', { name: '明细' }).click()
    await expect(win.locator('.ant-table-tbody tr')).toHaveCount(6)
    await expect(win.locator('.ant-table-tbody')).toContainText('测试午饭')

    // 4. 文件断言：末尾追加序列化交易块（长度增长 + 内容匹配）
    const content = readFileSync(ledgerPath, 'utf8')
    expect(statSync(ledgerPath).size).toBeGreaterThan(beforeSize)
    expect(content).toMatch(ENTRY_BLOCK_RE)

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})

test('M4 失败：借贷不平衡 → 错误提示 + 文件不变', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    await win.getByLabel('交易对象').fill('不平衡测试')
    await win.getByLabel('账户').nth(0).fill('Expenses:Food')
    await win.getByLabel('金额').nth(0).fill('100.00')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await win.getByLabel('账户').nth(1).fill('Assets:Cash')
    await win.getByLabel('金额').nth(1).fill('-99.00')
    await win.getByLabel('货币').nth(1).fill('CNY')

    const before = readFileSync(ledgerPath, 'utf8')
    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('借贷不平衡')
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})

test('M4 首文件：路径不存在 → 录入自动创建账本（open 行 + 交易块）', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'beanwise-e2e-first-'))
  const ledgerPath = join(tmpDir, 'main.beancount') // 打开目录时创建为空文件
  try {
    const app = await electron.launch({
      args: launchArgs
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    await win.getByLabel('交易对象').fill('首笔')
    await win.getByLabel('账户').nth(0).fill('Expenses:Food')
    await win.getByLabel('金额').nth(0).fill('10')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await win.getByLabel('账户').nth(1).fill('Assets:Bank:CNB')
    await win.getByLabel('货币').nth(1).fill('CNY')

    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')

    // 文件 = 账户 open 行 + 交易块（beancount 未 open 账户报 ValidationError）
    const content = readFileSync(ledgerPath, 'utf8')
    expect(content).toMatch(
      /^20\d{2}-\d{2}-\d{2} open Expenses:Food\n20\d{2}-\d{2}-\d{2} open Assets:Bank:CNB\n20\d{2}-\d{2}-\d{2} \* "首笔"\n  Expenses:Food  10 CNY\n  Assets:Bank:CNB  -10 CNY\n$/
    )

    await app.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
