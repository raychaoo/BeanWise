import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cleanupFixture, createFixtureCopy, seedAccountConfig } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

// 并行批次 e2e / 多会话并跑时 CPU 饱载，渲染与 IPC 往返显著变慢：整体放宽单测预算
test.setTimeout(240_000)

/** E2E 不复用全局工作目录；显式激活临时目录后重载（同 ledger-index.spec.ts）。 */
async function launchWithWorkspace(ledgerPath: string) {
  const app = await electron.launch({ args: launchArgs })
  const win = await app.firstWindow()
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  // 批次 G 回归修复：openWorkspace 的索引刷新是 fire-and-forget，reload 前不等待会让
  // reload 后读到的 ledger_meta 无运营货币 → 期初余额货币默认空（combobox 值非 CNY）。
  // 显式等 ledger_meta 就绪（getLedgerStatus 的 operatingCurrency 非空）再 reload。
  await win.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const s = await window.beanwise.getLedgerStatus()
      if (s && s.operatingCurrency && s.operatingCurrency.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('等待运营货币就绪超时')
  })
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
    seedAccountConfig(ledgerPath, [
      { id: 1, name: '银行卡', value: 'Assets:Bank:CNB' },
      { id: 2, name: '旧账户', value: 'Assets:Old', enabled: false },
      { id: 3, name: '吃饭', value: 'Expenses:Food' }
    ])
    const { app, win } = await launchWithWorkspace(ledgerPath)

    // 配置 3 行全可见；种子 enabled:false 的「旧账户」开关为未勾选态
    // （按 .ant-table-row 计数：ProTable 配了横向滚动，tbody 内另有 1 行隐藏 measure <tr>，
    //   直接数 tr 会多 1；同 ledger-index.spec.ts 的 dataRows 写法）
    await expect(win.locator('.ant-table-tbody .ant-table-row')).toHaveCount(3, { timeout: 20000 })
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
    // 选中结果作用域限定到分录行账户框：`.ant-select-selection-item` 全局定位会命中
    // App 四视图常驻挂载的隐藏 Select，以及分录行内默认带值（CNY）的货币 AutoComplete
    // ——录入页重设计后这些恒存在，全局计数不再是「0 = 未选中」。
    const selectedAccounts = win.locator('.posting-row__account .ant-select-selection-item')
    await trigger.click()
    await trigger.fill('Assets:Bank:CNB')
    await win.keyboard.press('Enter')
    await expect(selectedAccounts).toHaveCount(0, { timeout: 10000 })
    await trigger.click()
    await trigger.fill('Assets:Old')
    await win.keyboard.press('Enter')
    await expect(selectedAccounts).toHaveCount(0, { timeout: 10000 })
    await trigger.click()
    await trigger.fill('吃饭')
    await win.keyboard.press('Enter')
    await expect(selectedAccounts.filter({ hasText: '吃饭' })).toBeVisible({ timeout: 10000 })
    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
  }
})

test('期初余额：账户页录入 → 走 add-entry 落账本（Equity 配对 + 未 open 账户自动补 open）→ 索引平衡', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    seedAccountConfig(ledgerPath, [
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
      .toMatch(/\n20\d{2}-\d{2}-\d{2} \* "" "期初余额"\n  id: "bw-[0-9a-f-]{36}"\n  time: "20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"\n  Assets:Bank:CNB  100 CNY\n  Equity:Opening-Balances  -100 CNY\n/)

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

    // 总账平衡：明细页重建索引成功且流水出现期初余额行。
    // python 引擎子进程在 Windows 会弹可见控制台抢前台（python-svc spawn 无 windowsHide，
    // 基础设施移交修复），可能吞掉一次菜单点击：同 launchWithWorkspace 做一次重试。
    await win.getByRole('menuitem', { name: '明细' }).click()
    let rebuild = win.getByRole('button', { name: '重建索引' })
    try {
      await expect(rebuild).toBeVisible({ timeout: 8000 })
    } catch {
      await win.getByRole('menuitem', { name: '明细' }).click()
      rebuild = win.getByRole('button', { name: '重建索引' })
      await expect(rebuild).toBeVisible({ timeout: 20000 })
    }
    await rebuild.click()
    await expect(win.locator('.ant-table-tbody')).toContainText('期初余额', { timeout: 30000 })
    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
  }
})

test('科目管理搜索：名称/用途 + 账户路径两个输入框（AND 叠加、清空复原、表体滚动）', async () => {
  const ledgerPath = createFixtureCopy()
  let app: ElectronApplication | undefined
  try {
    seedAccountConfig(ledgerPath, [
      { id: 1, name: '招商银行', value: 'Assets:Bank:CNB', description: '工资卡' },
      { id: 2, name: '现金', value: 'Assets:Cash', description: '备用零钱' },
      { id: 3, name: '吃饭', value: 'Expenses:Food', description: '日常餐饮' }
    ])
    const launched = await launchWithWorkspace(ledgerPath)
    app = launched.app
    const win = launched.win

    const tbody = win.locator('.ant-table-tbody')
    const rows = tbody.locator('.ant-table-row')
    await expect(rows).toHaveCount(3, { timeout: 20000 })

    // 表体滚动条（2026-09-16）：y 触发 rc-table 固定表头（表头/表体拆两个 table），
    // 表体挂 maxHeight + overflowY——只配 x 时不会有 .ant-table-body 这个节点
    await expect(win.locator('.ant-table-body')).toHaveCSS('overflow-y', 'scroll')

    const nameSearch = win.getByPlaceholder('搜索名称 / 用途')
    const pathSearch = win.getByPlaceholder('搜索账户路径')

    // 名称/用途列渲染的是 Input（值不在文本内容里，读不出 textContent），
    // 故「剩下哪一行」按路径列文本判定——它是 Typography.Text，有真实文本。
    await nameSearch.fill('招商')
    await expect(rows).toHaveCount(1)
    await expect(tbody).toContainText('Assets:Bank:CNB')
    // 同一框也命中「用途」
    await nameSearch.fill('备用')
    await expect(rows).toHaveCount(1)
    await expect(tbody).toContainText('Assets:Cash')

    // 路径线独立成框，大小写不敏感
    await nameSearch.fill('')
    await pathSearch.fill('expenses')
    await expect(rows).toHaveCount(1)
    await expect(tbody).toContainText('Expenses:Food')

    // 两条线 AND 叠加：名称命中 + 路径不命中 → 空表，文案区别于「暂无配置账户」
    await nameSearch.fill('招商')
    await expect(rows).toHaveCount(0)
    await expect(win.locator('.ant-table-placeholder')).toContainText('无匹配科目')

    // 清空两框复原全量
    await nameSearch.fill('')
    await pathSearch.fill('')
    await expect(rows).toHaveCount(3)

    await app.close()
  } finally {
    await app?.close().catch(() => {})
    await cleanupFixture(ledgerPath)
  }
})
