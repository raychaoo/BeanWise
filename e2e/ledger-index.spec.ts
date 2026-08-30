import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  // 批次 A 路由化：默认路由为总览，先进「录入」页再断言 ProForm 链路
  await win.getByRole('menuitem', { name: '录入' }).click()
  await expect(win.getByRole('button', { name: '写入账本' })).toBeVisible()
}

/**
 * 账户字段下拉点选（批次 A 实测确立）：antd Select 的 fill() 只写搜索文本、
 * 失焦即丢弃、不落表单值（基线 ui-v4 同样如此）。
 * 采用键盘选择：点开下拉 → fill 过滤（此处 fill 恰好等价于输入搜索词）→ Enter 选中
 * 高亮项。不用点 option：表单靠视口底部时下拉被窗口裁剪，点击会无限重试（溢出修复无效，
 * 弹层绝对定位跟随触发器，滚动改变不了其视口位置）。
 */
async function pickAccount(win: Page, row: number, account: string): Promise<void> {
  const trigger = win.getByLabel('账户').nth(row)
  await trigger.click()
  await trigger.fill(account)
  await win.keyboard.press('Enter')
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
    await pickAccount(win, 0, 'Expenses:Food')
    await win.getByLabel('金额').nth(0).fill('25.50')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await pickAccount(win, 1, 'Assets:Bank:CNB')
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
    await pickAccount(win, 0, 'Expenses:Food')
    await win.getByLabel('金额').nth(0).fill('100.00')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await pickAccount(win, 1, 'Assets:Bank:CNB') // fixture 仅含 Bank:CNB/Opening-Balances/Food，原 Assets:Cash 无选项可点
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
  // 空账本的索引无历史账户，录入行下拉没有可选项：预置账户库（批次 A 实测：
  // antd Select 无法输入任意新账户，须从账户库点选）
  mkdirSync(join(tmpDir, '.beanwise'), { recursive: true })
  writeFileSync(
    join(tmpDir, '.beanwise', 'accounts.json'),
    JSON.stringify(
      {
        accounts: [
          { id: 1, name: 'Expenses:Food', value: 'Expenses:Food' },
          { id: 2, name: 'Assets:Bank:CNB', value: 'Assets:Bank:CNB' }
        ]
      },
      null,
      2
    ),
    'utf8'
  )
  try {
    const app = await electron.launch({
      args: launchArgs
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    await win.getByLabel('交易对象').fill('首笔')
    await pickAccount(win, 0, 'Expenses:Food')
    await win.getByLabel('金额').nth(0).fill('10')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await pickAccount(win, 1, 'Assets:Bank:CNB')
    await win.getByLabel('货币').nth(1).fill('CNY')

    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')

    // 文件 = options 头（title + operating_currency）+ 账户 open 行 + 交易块
// （2026-08-23 回归修复：首笔录入必须带运营货币 option，否则报表图表恒空）
    const content = readFileSync(ledgerPath, 'utf8')
    expect(content).toMatch(
      /^option "title" "BeanWise"\noption "operating_currency" "CNY"\n\n20\d{2}-\d{2}-\d{2} open Expenses:Food\n20\d{2}-\d{2}-\d{2} open Assets:Bank:CNB\n20\d{2}-\d{2}-\d{2} \* "首笔"\n  Expenses:Food  10 CNY\n  Assets:Bank:CNB  -10 CNY\n$/
    )

    await app.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('M4+ 明细：服务端倒序/正序、时间筛选与关键词搜索（超 UI 层 #2）', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    const dataRows = win.locator('.ant-table-tbody .ant-table-row')
    await win.getByRole('menuitem', { name: '明细' }).click()
    await win.getByRole('button', { name: '重建索引' }).click()
    await expect(dataRows).toHaveCount(5)

    // 默认倒序（服务端 desc）：首行 = 最新日期；列头 aria-sort 基线断言
    // （注：runner 下模拟点击列头存在协议层挂死，方向切换的 SQL 语义由 index-builder 单测 order=asc/desc 覆盖）
    const firstCell = dataRows.first().locator('td').first()
    await expect(firstCell).toHaveText('2026-01-03', { timeout: 5000 })
    await expect(win.getByRole('columnheader', { name: /日期/ })).toHaveAttribute('aria-sort', 'descending', { timeout: 5000 })

    // 时间筛选（服务端 dateFrom/dateTo）：今日 → fixture 全为 2026-01 → 空态；切「全部」恢复
    // （空态用占位行结构断言：antd Table 空态文案随 locale，不作断言依赖）
    await win.getByText('今日', { exact: true }).click({ timeout: 10_000 })
    await expect(win.locator('.ant-table-tbody .ant-table-placeholder')).toBeVisible({ timeout: 10_000 })
    await win.getByText('全部', { exact: true }).click({ timeout: 10_000 })
    await expect(dataRows).toHaveCount(5, { timeout: 10_000 })

    // 关键词搜索（服务端 keyword，交易级命中）：说明命中 1 行；账户命中含 open 行共 3 行
    const search = win.getByPlaceholder('搜索交易对象 / 说明 / 账户')
    await search.fill('Breakfast')
    await search.press('Enter')
    await expect(dataRows).toHaveCount(1)
    await expect(win.locator('.ant-table-tbody')).toContainText('Breakfast')
    await search.fill('Bank')
    await search.press('Enter')
    await expect(dataRows).toHaveCount(3)
    // 清空搜索恢复全量（allowClear 清空 → onChange 重查）
    await search.fill('')
    await expect(dataRows).toHaveCount(5)

    // 录入页最近流水卡显示交易金额（超 UI 层 #1，资产流视角：支出负）
    await win.getByRole('menuitem', { name: '录入' }).click()
    await expect(win.locator('.entry-recent-list')).toContainText('-15 CNY')

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})
