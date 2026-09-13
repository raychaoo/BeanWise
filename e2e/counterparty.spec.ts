import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** 激活工作区 + 等运营货币就绪 + reload（同 account-config.spec.ts：索引刷新是 fire-and-forget） */
async function activateWorkspace(win: Page, wsDir: string): Promise<void> {
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, wsDir)
  await win.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const s = await window.beanwise.getLedgerStatus()
      if (s && s.operatingCurrency && s.operatingCurrency.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('等待运营货币就绪超时')
  })
  await win.reload()
}

/**
 * 账户字段下拉点选（同 ledger-index.spec.ts）：antd Select 的 fill() 只写搜索文本、
 * 失焦即丢弃，故走键盘选择——点开下拉 → fill 过滤 → Enter 选中高亮项。
 *
 * ⚠️ 传的是**显示名**而非账户路径：Select 配了 optionFilterProp="label"，过滤只认 label
 * （账户库条目 label = 中文名，如「借出」；账本历史账户 label = 路径本身）。传路径会让
 * 过滤后无候选、Enter 落空且不报错——静默表现为「账户没选上」。
 */
async function pickAccount(win: Page, row: number, label: string): Promise<void> {
  const trigger = win.getByLabel('账户').nth(row)
  await trigger.click()
  await trigger.fill(label)
  await win.keyboard.press('Enter')
}

/**
 * ADR 23 往来账全链路：账户库标记「往来」→ 录入页出现「往来对象」→ 落成 posting 级
 * metadata → 往来账报表按对象聚合。这条链路跨越 shared/main/renderer 三层，单测覆盖不到。
 */
test('ADR 23：标记往来类 → 录入带对象 → 文件落 metadata → 往来账报表按对象聚合', async () => {
  const ledgerPath = createFixtureCopy()
  let app: ElectronApplication | undefined
  try {
    seedAccountConfig(dirname(ledgerPath), [
      { id: 1, name: '招商银行', value: 'Assets:Bank:CNB' },
      { id: 2, name: '借出', value: 'Assets:Receivables:Lend', counterparty: true }
    ])
    app = await electron.launch({ args: launchArgs })
    const win = await app.firstWindow()
    await activateWorkspace(win, dirname(ledgerPath))
    await win.getByRole('menuitem', { name: '录入' }).click()
    await expect(win.getByRole('button', { name: '写入账本' })).toBeVisible({ timeout: 20000 })

    // 1. 「往来对象」只出现在往来类账户行：未选账户时两行都没有
    await expect(win.getByLabel('往来对象')).toHaveCount(0)
    await pickAccount(win, 0, '借出')
    // 选中后该行显示中文名（失败时给出比「往来对象=0」更直白的信号）
    await expect(win.locator('.posting-row').nth(0)).toContainText('借出')
    await expect(win.getByLabel('往来对象')).toHaveCount(1)

    // 2. 填单：借出 5000，对象填 李素珍
    await win.getByLabel('交易对象').fill('李素珍')
    await win.getByLabel('说明').fill('转账汇款')
    await win.getByLabel('金额').nth(0).fill('5000')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await pickAccount(win, 1, '招商银行')
    await win.getByLabel('货币').nth(1).fill('CNY')
    await win.getByLabel('往来对象').fill('李素珍')

    // 3. 落盘：posting 级 metadata（缩进 4 格）只挂在借出那条分录下；交易级 ^link 由主进程自动盖
    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')
    await expect
      .poll(() => readFileSync(ledgerPath, 'utf8'))
      .toMatch(/  Assets:Receivables:Lend  5000 CNY\n    counterparty: "李素珍"\n/)
    const lendIds = [...readFileSync(ledgerPath, 'utf8').matchAll(/\^(lend-[A-Za-z0-9]+)/g)].map((m) => m[1])
    expect(lendIds).toHaveLength(1)

    // 4. 还款 5000：往来类账户填第二行（金额符号由账户类型决定，第二行记负 = 冲减应收）；
    //    主进程按 FIFO 自动把 link 挂到上面那笔借出（同一个 ID）
    await pickAccount(win, 0, '招商银行')
    await win.getByLabel('金额').nth(0).fill('5000')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await pickAccount(win, 1, '借出')
    await win.getByLabel('货币').nth(1).fill('CNY')
    await win.getByLabel('往来对象').fill('李素珍')
    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')

    await expect
      .poll(() => [...readFileSync(ledgerPath, 'utf8').matchAll(/\^(lend-[A-Za-z0-9]+)/g)].map((m) => m[1]))
      .toEqual([lendIds[0], lendIds[0]])

    // 5. 报表：往来账 Tab 按对象聚合（借出 5000 已还清 → 净额 0），逐笔明细显示已结清
    await win.getByRole('menuitem', { name: '报表' }).click()
    await win.getByRole('tab', { name: '往来账' }).click()
    const pane = win.locator('.ant-tabs-tabpane-active')
    await expect(pane.locator('.ant-table-tbody').first()).toContainText('李素珍', { timeout: 20000 })
    const loans = pane.locator('.counterparty-loans')
    await expect(loans).toContainText('李素珍')
    await expect(loans).toContainText('已结清')
    await expect(loans).toContainText('5,000')
  } finally {
    // app.close() 必须进 finally：断言失败时若跳过，Electron 进程残留会让整个 worker 卡住
    await app?.close().catch(() => {})
    cleanupFixture(ledgerPath)
  }
})

test('ADR 23：账户库未标记往来类 → 往来账给出「去标记」引导而非空表', async () => {
  const ledgerPath = createFixtureCopy()
  let app: ElectronApplication | undefined
  try {
    seedAccountConfig(dirname(ledgerPath), [{ id: 1, name: '招商银行', value: 'Assets:Bank:CNB' }])
    app = await electron.launch({ args: launchArgs })
    const win = await app.firstWindow()
    await activateWorkspace(win, dirname(ledgerPath))
    await win.getByRole('menuitem', { name: '报表' }).click()
    await win.getByRole('tab', { name: '往来账' }).click()
    const pane = win.locator('.ant-tabs-tabpane-active')
    await expect(pane).toContainText('尚未标记任何往来类账户', { timeout: 20000 })
    await expect(pane).toContainText('科目管理')
  } finally {
    await app?.close().catch(() => {})
    cleanupFixture(ledgerPath)
  }
})
