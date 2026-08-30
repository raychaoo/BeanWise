import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanupFixture, createFixtureCopy } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

// 并行批次 e2e / 多会话并跑时 CPU 饱载，渲染与 IPC 往返显著变慢：整体放宽单测预算
test.setTimeout(240_000)

/** 预置账户库配置（<workspace>/.beanwise/accounts.json），激活工作区前写入 */
function seedAccountConfig(workspaceDir: string, accounts: unknown[]): void {
  mkdirSync(join(workspaceDir, '.beanwise'), { recursive: true })
  writeFileSync(join(workspaceDir, '.beanwise', 'accounts.json'), JSON.stringify({ accounts }, null, 2), 'utf8')
}

/** E2E 不复用全局工作目录；显式激活临时目录后重载（同 ledger-index.spec.ts）。 */
async function launchWithWorkspace(ledgerPath: string) {
  const app = await electron.launch({ args: launchArgs })
  const win = await app.firstWindow()
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  await win.reload()
  await win.getByRole('menuitem', { name: '账户' }).click()
  // 饱载下 reload 后首个点击可能落在路由挂载完成前而被吞：未达账户页则重试一次
  try {
    await expect(win.getByText('科目管理')).toBeVisible({ timeout: 8000 })
  } catch {
    await win.getByRole('menuitem', { name: '账户' }).click()
    await expect(win.getByText('科目管理')).toBeVisible({ timeout: 20000 })
  }
  // antd 两字按钮自动插空格（保存 → 保 存），须用正则匹配
  await expect(win.getByRole('button', { name: /保\s*存/ })).toBeVisible({ timeout: 20000 })
  return { app, win }
}

test('启停用：账户页停用并保存 → enabled 落盘 → 录入下拉不再出现（含账本历史账户不回灌）', async () => {
  const ledgerPath = createFixtureCopy()
  const accountsPath = join(dirname(ledgerPath), '.beanwise', 'accounts.json')
  try {
    seedAccountConfig(dirname(ledgerPath), [
      { id: 1, name: '银行卡', value: 'Assets:Bank:CNB' },
      { id: 2, name: '旧账户', value: 'Assets:Old', enabled: false },
      { id: 3, name: '吃饭', value: 'Expenses:Food' }
    ])
    const { app, win } = await launchWithWorkspace(ledgerPath)

    // 配置 3 行全可见；种子 enabled:false 的「旧账户」开关为未勾选态
    await expect(win.locator('.ant-table-tbody tr')).toHaveCount(3, { timeout: 20000 })
    await expect(win.getByLabel('启停用 旧账户')).not.toBeChecked()
    await expect(win.getByLabel('启停用 银行卡')).toBeChecked()

    // 停用「银行卡」→ 保存（显式保存模型：切换不即时写盘）
    await win.getByLabel('启停用 银行卡').click()
    expect(JSON.parse(readFileSync(accountsPath, 'utf8')).accounts.find((a: { name: string }) => a.name === '银行卡').enabled).toBeUndefined()

    await win.getByRole('button', { name: /保\s*存/ }).click()
    // 落盘轮询（不用 message 断言：antd message 3s 自动消失，负载下易闪失）
    await expect
      .poll(() => JSON.parse(readFileSync(accountsPath, 'utf8')).accounts.find((a: { name: string }) => a.name === '银行卡').enabled, { timeout: 20000 })
      .toBe(false)
    expect(JSON.parse(readFileSync(accountsPath, 'utf8')).accounts.find((a: { name: string }) => a.name === '吃饭')).not.toHaveProperty('enabled')

    // 录入页账户下拉过滤：停用账户不可选（含账本历史不回灌），启用配置可选。
    // 断言走选择结果而非下拉 DOM（click→fill→Enter 为 ledger-index.spec.ts 实证交互）；
    // 配置账户的搜索字段是中文名 label 而非路径。combobox 角色限定避开账户页
    // 「启停用 旧账户」Switch 的 aria-label 子串误匹配。
    await win.getByRole('menuitem', { name: '录入' }).click()
    let trigger = win.getByRole('combobox', { name: /账户/ }).first()
    try {
      await expect(trigger).toBeVisible({ timeout: 8000 })
    } catch {
      await win.getByRole('menuitem', { name: '录入' }).click()
      trigger = win.getByRole('combobox', { name: /账户/ }).first()
      await expect(trigger).toBeVisible({ timeout: 20000 })
    }
    await trigger.click()
    await trigger.fill('Assets:Bank:CNB')
    await win.keyboard.press('Enter')
    await expect(win.locator('.ant-select-selection-item')).toHaveCount(0, { timeout: 10000 })
    await trigger.click()
    await trigger.fill('Assets:Old')
    await win.keyboard.press('Enter')
    await expect(win.locator('.ant-select-selection-item')).toHaveCount(0, { timeout: 10000 })
    await trigger.click()
    await trigger.fill('吃饭')
    await win.keyboard.press('Enter')
    await expect(win.locator('.ant-select-selection-item').filter({ hasText: '吃饭' })).toBeVisible({ timeout: 10000 })
    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})

test('期初余额：账户页录入 → 走 add-entry 落账本（Equity 配对 + 未 open 账户自动补 open）→ 索引平衡', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    seedAccountConfig(dirname(ledgerPath), [
      { id: 1, name: '银行卡', value: 'Assets:Bank:CNB' },
      { id: 2, name: '现金', value: 'Assets:Cash' } // fixture 未 open → 实测主进程自动补 open 行
    ])
    const { app, win } = await launchWithWorkspace(ledgerPath)

    // 行 1：Assets:Bank:CNB 期初 100 CNY（fixture 运营货币默认进货币框）
    await win.getByLabel('期初余额 银行卡').click()
    await win.getByPlaceholder('金额 0.00').fill('100')
    // 货币默认运营货币 CNY（aria-label 同时挂在 wrapper 与 input 上，用 combobox 角色消歧）
    await expect(win.getByRole('combobox', { name: '期初余额货币' })).toHaveValue('CNY', { timeout: 20000 })
    await win.getByRole('button', { name: '下一步' }).click()
    // antd confirm 弹窗标题有两层节点：隐藏的 aria 用 .ant-modal-title + 可见的 .ant-modal-confirm-title
    await expect(win.locator('.ant-modal-confirm-title', { hasText: '确认写入期初余额' })).toBeVisible({ timeout: 20000 })
    await win.getByRole('button', { name: /确\s*定/ }).click()
    await expect
      .poll(() => readFileSync(ledgerPath, 'utf8'), { timeout: 30000 })
      .toMatch(/\n20\d{2}-\d{2}-\d{2} \* "" "期初余额"\n  Assets:Bank:CNB  100 CNY\n  Equity:Opening-Balances  -100 CNY\n/)

    // 行 2：未 open 的 Assets:Cash → add-entry 自动补 open（Task 4 Step 3 实测结论的端到端回归）
    await win.getByLabel('期初余额 现金').click()
    await win.getByPlaceholder('金额 0.00').fill('50')
    await win.getByRole('button', { name: '下一步' }).click()
    await win.getByRole('button', { name: /确\s*定/ }).click()
    await expect
      .poll(() => readFileSync(ledgerPath, 'utf8'), { timeout: 30000 })
      .toMatch(/20\d{2}-\d{2}-\d{2} open Assets:Cash\n/)
    await expect
      .poll(() => readFileSync(ledgerPath, 'utf8'), { timeout: 30000 })
      .toMatch(/  Assets:Cash  50 CNY\n  Equity:Opening-Balances  -50 CNY\n/)

    // 总账平衡：明细页重建索引成功且流水出现期初余额行
    await win.getByRole('menuitem', { name: '明细' }).click()
    await win.getByRole('button', { name: '重建索引' }).click()
    await expect(win.locator('.ant-table-tbody')).toContainText('期初余额', { timeout: 30000 })
    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})
