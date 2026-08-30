/**
 * M8 E2E（T8）：报表视图绿灯——真实账本数据（reports.beancount 副本）→
 * IPC 返回精确聚合（decimal 字符串）+ UI 渲染无错误 + 余额表精确文本 + 图表容器存在。
 * 断言口径：canvas 文本不可 DOM 断言，以 IPC 数据 + 表格文本为准（Global Constraints 偏差②）。
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { cleanupFixture } from './fixtures/setup'

const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

/** E2E 不复用全局工作目录；显式激活临时目录后重载，让渲染端拿到新运行时（M9 工作目录模型）。 */
async function activateWorkspace(win: Page, ledgerPath: string): Promise<void> {
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  await win.reload()
  await expect(win.getByRole('menuitem', { name: '报表' })).toBeVisible()
}

/** reports.beancount 副本（临时目录） */
function createReportsFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beanwise-reports-'))
  copyFileSync(resolve('python/tests/fixtures/reports.beancount'), join(dir, 'main.beancount'))
  return join(dir, 'main.beancount')
}

test('M8 报表：真实数据渲染（IPC 聚合 + 余额表 + 图表容器）', async () => {
  test.setTimeout(120_000)
  const ledgerPath = createReportsFixture()
  try {
    const app = await electron.launch({ args: launchArgs })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)

    // 1. IPC 真实数据链路：净资产月趋势（期末累计，decimal 精确字符串）。
    // 实测修正（M8-T8）：启动索引重建是 fire-and-forget（index-builder.refreshIndex），
    // 首窗立即查询可能命中上一轮索引 → 用 expect.poll 等新索引重建完成，断言值与简报完全一致
    await expect
      .poll(
        async () => {
          const nw = await win.evaluate(() => window.beanwise.getNetWorthReport({ granularity: 'month' }))
          return { currency: nw.currency, jan: nw.series.find((p) => p.period === '2026-01') }
        },
        { timeout: 30_000 }
      )
      .toEqual({ currency: 'CNY', jan: { period: '2026-01', assets: '9960', liabilities: '-20', netWorth: '9940' } })

    // 2. IPC：余额树 rollup
    const bal = await win.evaluate(() => window.beanwise.getBalancesReport())
    const assets = bal.accounts.find((a) => a.name === 'Assets')
    expect(assets?.balances).toEqual([{ currency: 'CNY', number: '19960' }])

    // 3. IPC：收支对比（月视图 12 个月补满，收入正显示）
    const ie = await win.evaluate(() => window.beanwise.getIncomeExpenseReport({ granularity: 'month', startYear: 2026, endYear: 2026 }))
    expect(ie.series).toHaveLength(12)
    expect(ie.series.find((p) => p.period === '2026-01')).toEqual({ period: '2026-01', income: '0', expense: '20' })
    expect(ie.series.find((p) => p.period === '2026-02')).toEqual({ period: '2026-02', income: '10000', expense: '0' })

    // 4. UI：报表视图渲染（菜单 → 面板可见 + 余额表精确文本 + 图表容器存在 + 无错误条）
    await win.getByRole('menuitem', { name: '报表' }).click()
    await expect(win.getByText('净资产趋势')).toBeVisible()
    await expect(win.getByText('收支对比')).toBeVisible()
    // 实测修正（M8-T8）：'账户余额' 文本同时命中 Card 标题与余额表表头行（账户|余额 两格）
    // → strict mode 冲突，收敛到 .ant-card-head-title 作用域
    await expect(win.locator('.ant-card-head-title', { hasText: '账户余额' })).toBeVisible()
    // 余额表精确金额文本（实测修正：App.tsx 多视图常驻挂载，EntriesView 表格也在 DOM 中，
    // .ant-table-tbody 命中 2 个 → 收敛到「账户余额」Card 作用域；toContainText 无需可见性，无需滚动）
    const balanceRows = win.locator('.ant-card', { hasText: '账户余额' }).locator('.ant-table-tbody')
    await expect(balanceRows).toContainText('19960 CNY')
    await expect(balanceRows).toContainText('-20 CNY')
    // 图表容器存在（G2 渲染 canvas；实测修正：EditorView 常驻挂载，其 Monaco
    // decorationsOverviewRuler canvas 在 DOM 序更前 → 收敛到「净资产趋势」Card 内断言）
    await expect(win.locator('.ant-card', { hasText: '净资产趋势' }).locator('canvas').first()).toBeVisible()
    // 无错误条
    await expect(win.locator('.ant-alert-error')).toHaveCount(0)

    // 4b. 起止年筛选：年份下拉可见 + IPC 范围过滤（净资产含范围前累计 / 余额期末快照 / 收支跨年 24 个月）
    await expect(win.locator('.ant-select', { hasText: '起始年' }).first()).toBeVisible()
    await expect(win.locator('.ant-select', { hasText: '结束年' }).first()).toBeVisible()
    const nwRange = await win.evaluate(() => window.beanwise.getNetWorthReport({ granularity: 'month', startYear: 2026, endYear: 2026 }))
    expect(nwRange.series).toEqual([{ period: '2026-01', assets: '9960', liabilities: '-20', netWorth: '9940' }, { period: '2026-02', assets: '19960', liabilities: '-20', netWorth: '19940' }])
    const balEnd2025 = await win.evaluate(() => window.beanwise.getBalancesReport({ endYear: 2025 }))
    expect(balEnd2025.accounts.find((a) => a.name === 'Assets')?.balances).toEqual([{ currency: 'CNY', number: '9960' }])
    expect(balEnd2025.accounts.find((a) => a.name === 'Liabilities')).toBeUndefined()
    const ieRange = await win.evaluate(() => window.beanwise.getIncomeExpenseReport({ granularity: 'month', startYear: 2025, endYear: 2026 }))
    expect(ieRange.series).toHaveLength(24)
    expect(ieRange.series.find((p) => p.period === '2025-03')).toEqual({ period: '2025-03', income: '10000', expense: '35' })
    const years = await win.evaluate(() => window.beanwise.getReportYears())
    expect(years).toEqual({ min: 2025, max: 2026 })

    // 5. 粒度切换：年视图不报错（图表容器仍在）
    // 实测修正：antd Segmented 的 radio input 视觉隐藏（不可点），可点区域是选项 label
    // → 按简报兜底策略走选项文本定位：.ant-segmented-item 作用域 hasText '年'
    await win.locator('.ant-segmented-item', { hasText: '年' }).click()
    await expect(win.locator('.ant-card', { hasText: '净资产趋势' }).locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.ant-alert-error')).toHaveCount(0)

    // 6. 批次 E：资产负债表（账户式）——双栏 + 会计恒等式校验通过
    // （fixture：资产 19960 = 负债 20（翻转正显示）+ 未分配利润 19940；inactive pane 仍挂载
    // destroyInactiveTabPane=false → 断言收敛到 .ant-tabs-tabpane-active）
    await win.locator('.ant-tabs-tab', { hasText: '资产负债表' }).click()
    const balancePane = win.locator('.ant-tabs-tabpane-active')
    await expect(balancePane.getByText('资产负债表').first()).toBeVisible()
    await expect(balancePane.getByText('Assets:Bank:CNB')).toBeVisible()
    await expect(balancePane.locator('tr', { hasText: 'Liabilities:CreditCard' })).toContainText('20')
    await expect(balancePane.getByText('资产合计')).toBeVisible()
    await expect(balancePane.getByText('负债和所有者权益合计')).toBeVisible()
    await expect(balancePane.getByText(/校验通过：资产 = 负债 \+ 权益/)).toBeVisible()
    await expect(balancePane.locator('.ant-tag-error')).toHaveCount(0)

    // 7. 批次 E：利润表（报告式）——本月汇总 + 累计明细（累计值与运行日期无关，可精确断言；
    // 本月行随运行日期变化，仅断言结构存在）
    await win.locator('.ant-tabs-tab', { hasText: '利润表' }).click()
    const incomePane = win.locator('.ant-tabs-tabpane-active')
    const thisYear = new Date().getFullYear()
    await expect(incomePane.getByText('利润表').first()).toBeVisible()
    await expect(incomePane.getByText(/本月（\d{4}年\d{2}月）/)).toBeVisible()
    await expect(incomePane.getByText(`收入明细（截至 ${thisYear} 年末累计）`)).toBeVisible()
    await expect(incomePane.locator('tr', { hasText: 'Income:Salary' })).toContainText('20,000')
    await expect(incomePane.locator('tr', { hasText: 'Expenses:Food' })).toContainText('55')
    await expect(incomePane.locator('tr', { hasText: '收入小计' })).toContainText('20,000')
    await expect(incomePane.locator('tr', { hasText: '支出小计' })).toContainText('60')
    await expect(incomePane.locator('tr', { hasText: `净利润（累计至 ${thisYear} 年末）` })).toContainText('19,940')
    // 切走再切回：destroyInactiveTabPane=false 保状态（趋势 Tab 图表容器仍在 DOM）
    await win.locator('.ant-tabs-tab', { hasText: '趋势图表' }).click()
    await expect(win.locator('.ant-card', { hasText: '净资产趋势' }).locator('canvas').first()).toBeVisible()
    await expect(win.locator('.ant-alert-error')).toHaveCount(0)

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})
