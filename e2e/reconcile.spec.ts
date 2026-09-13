/**
 * 对账页 E2E（批次 F）：明细账 Tab 账户过滤接真数据（超 UI 层 #2 收尾）。
 * 进对账页 → Tab② TreeSelect 选 Expenses:Food → 表格出现该账户分录行且账户列含 Food。
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanupFixture, createFixtureCopy } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

// 流程含 Python 冷启动 + 重建索引 + Tab 切换，比单页 spec 慢，放宽单测超时
test.setTimeout(180_000)

/** E2E 不复用全局工作目录；显式激活临时目录后重载（与 ledger-index.spec 同模式）。 */
async function activateWorkspace(win: Page, ledgerPath: string): Promise<void> {
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  // 批次 G 回归修复：workspace:open 的索引刷新是 fire-and-forget，reload 前不等待会让
  // reload 后触发的 loadAccounts 读到空 postings → 对账页 Tab② 账户树「No data」。
  // 显式等 postings 就绪（listLedgerAccounts 非空）再 reload，账户下拉随新索引刷新。
  await win.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const r = await window.beanwise.listLedgerAccounts()
      if (r.accounts.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('等待索引就绪超时')
  })
  await win.reload()
  await win.getByRole('menuitem', { name: '录入' }).click()
  await expect(win.getByRole('button', { name: '写入账本' })).toBeVisible()
}

test('批次 F：明细账账户过滤（TreeSelect 选 Expenses:Food → 该账户分录行）', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    // 明细页确定性重建索引（postings 就绪），再进对账页
    await win.getByRole('menuitem', { name: '明细' }).click()
    await win.getByRole('button', { name: '重建索引' }).click()
    await expect(win.locator('.ant-table-tbody .ant-table-row')).toHaveCount(5, { timeout: 15_000 })

    await win.getByRole('menuitem', { name: '对账' }).click()
    await win.getByRole('tab', { name: '明细账' }).click()

    // 未选账户：引导空态（占位 Empty 已删除，真数据空态引导）
    await expect(win.getByText('选择账户后查看其明细分录')).toBeVisible()

    // TreeSelect（五大类分组）：临时目录无账户库配置 → label = 原始路径，输入过滤后点选。
    // 注意 rc-select 搜索 input 无 placeholder 属性（placeholder 是独立 div），须用容器/类名定位
    await win.locator('.reconcile-detail-toolbar .ant-select').click()
    await win.locator('.reconcile-detail-toolbar .ant-select-selection-search-input').fill('Food')
    await win.locator('.ant-select-tree-title', { hasText: 'Expenses:Food' }).click()

    // 表格出现该账户分录行（服务端 account 精确过滤 + desc：Coffee 倒序在前），账户列含 Food。
    // 断言收敛到激活面板：antd Tabs 非激活面板默认保持挂载，全页 locator 会混入 Tab① 余额表行
    const pane = win.locator('.ant-tabs-tabpane-active')
    const rows = pane.locator('.ant-table-tbody .ant-table-row')
    await expect(rows).toHaveCount(2, { timeout: 10_000 })
    await expect(rows.first()).toContainText('Coffee')
    await expect(pane).toContainText('Expenses:Food')
    // 金额列（资产流视角：支出 -25，千分位格式化）+ 币种列 + total 同条件计数
    await expect(rows.first()).toContainText('-25')
    await expect(rows.first()).toContainText('CNY')
    await expect(win.getByText('共 2 条')).toBeVisible()

    // allowClear 清空 → 回引导空态（本 Tab 不做全库查询）
    await win.locator('.ant-select-clear').click()
    await expect(win.getByText('选择账户后查看其明细分录')).toBeVisible()

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})

test('对账明细账：ID/完整时间展示，金额、交易对象、说明搜索与抽屉编辑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beanwise-reconcile-detail-'))
  const ledgerPath = join(dir, 'main.beancount')
  writeFileSync(
    ledgerPath,
    'option "title" "Reconcile Detail"\noption "operating_currency" "CNY"\n\n' +
      '2026-01-01 open Assets:Bank:CNB\n' +
      '2026-01-01 open Expenses:Food\n\n' +
      '2026-08-22 * "麦当劳" "早餐"\n' +
      '  id: "bw-reconcile-1"\n' +
      '  time: "2026-08-22 08:15:30"\n' +
      '  Expenses:Food  17.40 CNY\n' +
      '  Assets:Bank:CNB  -17.40 CNY\n\n' +
      '2026-08-23 * "瑞幸咖啡" "咖啡"\n' +
      '  id: "bw-reconcile-2"\n' +
      '  time: "2026-08-23 12:34:56"\n' +
      '  Expenses:Food  25.00 CNY\n' +
      '  Assets:Bank:CNB  -25.00 CNY\n',
    'utf8'
  )

  try {
    const app = await electron.launch({ args: launchArgs })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    await win.getByRole('menuitem', { name: '对账' }).click()
    await win.getByRole('tab', { name: '明细账' }).click()
    await win.locator('.reconcile-detail-toolbar .ant-select').click()
    await win.locator('.reconcile-detail-toolbar .ant-select-selection-search-input').fill('Food')
    await win.locator('.ant-select-tree-title', { hasText: 'Expenses:Food' }).click()

    const pane = win.locator('.ant-tabs-tabpane-active')
    const rows = pane.locator('.ant-table-tbody .ant-table-row')
    await expect(rows).toHaveCount(2, { timeout: 15_000 })
    await expect(rows.first()).toContainText('bw-reconcile-2')
    await expect(rows.first()).toContainText('2026-08-23 12:34:56')
    await expect(rows.first()).toContainText('-25')

    const search = pane.getByPlaceholder('搜索金额 / 交易对象 / 说明')
    await search.fill('17.4')
    await search.press('Enter')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('bw-reconcile-1')

    await search.fill('瑞幸')
    await search.press('Enter')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('bw-reconcile-2')

    await search.fill('早餐')
    await search.press('Enter')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('bw-reconcile-1')

    await search.fill('')
    await expect(rows).toHaveCount(2)
    await pane.getByRole('button', { name: '编辑 bw-reconcile-2' }).click()
    const drawer = win.getByRole('dialog')
    await expect(drawer.getByText('bw-reconcile-2')).toBeVisible()
    await expect(drawer.getByLabel('日期')).toHaveValue('2026-08-23 12:34:56')
    await drawer.getByLabel('说明').fill('抽屉编辑后')
    await drawer.getByRole('button', { name: '保存修改' }).click()
    await expect(win.locator('.ant-message')).toContainText('已更新并校验通过')
    await expect(rows.first()).toContainText('抽屉编辑后')
    expect(readFileSync(ledgerPath, 'utf8')).toContain('id: "bw-reconcile-2"')

    await app.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
