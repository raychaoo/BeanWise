/**
 * M8 E2E（T8）：报表视图绿灯——真实账本数据（reports.beancount 副本）→
 * IPC 返回精确聚合（decimal 字符串）+ UI 渲染无错误 + 余额表精确文本 + 图表容器存在。
 * 断言口径：canvas 文本不可 DOM 断言，以 IPC 数据 + 表格文本为准（Global Constraints 偏差②）。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

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
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()

    // 1. IPC 真实数据链路：净资产月趋势（期末累计，decimal 精确字符串）。
    // 实测修正（M8-T8）：启动索引重建是 fire-and-forget（index-builder.refreshIndex），
    // 首窗立即查询会命中 userData 持久化 DB 的上一轮索引（实测残留 main.beancount 数据）
    // → 用 expect.poll 等新索引重建完成，断言值与简报完全一致
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
    const ie = await win.evaluate(() => window.beanwise.getIncomeExpenseReport({ granularity: 'month', year: 2026 }))
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

    // 5. 粒度切换：年视图不报错（图表容器仍在）
    // 实测修正：antd Segmented 的 radio input 视觉隐藏（不可点），可点区域是选项 label
    // → 按简报兜底策略走选项文本定位：.ant-segmented-item 作用域 hasText '年'
    await win.locator('.ant-segmented-item', { hasText: '年' }).click()
    await expect(win.locator('.ant-card', { hasText: '净资产趋势' }).locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.ant-alert-error')).toHaveCount(0)

    await app.close()
  } finally {
    rmSync(dirname(ledgerPath), { recursive: true, force: true })
  }
})
