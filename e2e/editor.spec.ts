import { _electron as electron, expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { cleanupFixture, createFixtureCopy } from './fixtures/setup'

const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

test('M5 绿灯：打开账本 → beancount 高亮 → 编辑保存 → 校验提示 → 索引联动', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()
    await win.getByRole('menuitem', { name: '编辑器' }).click()

    // 1. 内容加载 + 高亮（tokenized span：class 形如 mtk1，用属性包含匹配）
    const editor = win.locator('.editor-main .monaco-editor')
    await expect(editor).toBeVisible()
    await expect(win.locator('.editor-main .view-lines')).toContainText('Breakfast')
    const tokenSpans = await win.locator('.editor-main .view-line [class*="mtk"]').count()
    expect(tokenSpans).toBeGreaterThan(0)

    // 2. 编辑：跳到文件尾追加一笔合法交易（fixture 已 open Expenses:Food / Assets:Bank:CNB）
    await win.locator('.editor-main .monaco-editor').click()
    await win.keyboard.press('Control+End')
    await win.keyboard.type('\n2026-08-09 * "M5 E2E" "编辑器保存"\n  Expenses:Food  8.00 CNY\n  Assets:Bank:CNB  -8.00 CNY')

    // 3. 保存 → 成功提示 + 文件断言 + 明细联动
    const before = readFileSync(ledgerPath, 'utf8')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.locator('.ant-message')).toContainText('已保存并校验通过')
    const after = readFileSync(ledgerPath, 'utf8')
    expect(after).toContain('"M5 E2E"')
    expect(after.length).toBeGreaterThan(before.length)

    await win.getByRole('menuitem', { name: '明细' }).click()
    await expect(win.locator('.ant-table-tbody')).toContainText('M5 E2E')

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})

test('M5 冲突：外部修改 → 保存触发冲突面板 → 重新加载回滚到磁盘内容', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()

    // 1. 编辑器先加载文件（基线指纹 F1）
    await win.getByRole('menuitem', { name: '编辑器' }).click()
    await expect(win.locator('.editor-main .view-lines')).toContainText('Breakfast')

    // 2. 外部修改：录入视图加一笔（文件 → F2，编辑器基线仍为 F1）
    await win.getByRole('menuitem', { name: '录入' }).click()
    await win.getByLabel('交易对象').fill('外部修改')
    await win.getByLabel('账户').nth(0).fill('Expenses:Food')
    await win.getByLabel('金额').nth(0).fill('25.50')
    await win.getByLabel('货币').nth(0).fill('CNY')
    await win.getByLabel('账户').nth(1).fill('Assets:Bank:CNB')
    await win.getByLabel('货币').nth(1).fill('CNY')
    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')

    // 3. 回编辑器改动并保存 → 冲突面板（DiffEditor 可见）
    await win.getByRole('menuitem', { name: '编辑器' }).click()
    await win.locator('.editor-main .monaco-editor').click()
    await win.keyboard.press('Control+End')
    await win.keyboard.type(' ')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.locator('.monaco-diff-editor').first()).toBeVisible()

    // 4. 重新加载 → 冲突面板消失，编辑器内容 = 磁盘内容（含「外部修改」）
    await win.getByRole('button', { name: '重新加载' }).click()
    await expect(win.locator('.monaco-diff-editor')).toHaveCount(0)
    await expect(win.locator('.editor-main .view-lines')).toContainText('外部修改')

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})

test('M5 失败：保存校验失败 → 错误提示 + 文件字节不变', async () => {
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()
    await win.getByRole('menuitem', { name: '编辑器' }).click()
    await expect(win.locator('.editor-main .view-lines')).toContainText('Breakfast')

    const before = readFileSync(ledgerPath, 'utf8')
    // 追加借贷不平的交易（10 vs -9）→ parse 失败，tmp 删除、原文件不动
    await win.locator('.editor-main .monaco-editor').click()
    await win.keyboard.press('Control+End')
    await win.keyboard.type('\n2026-08-09 * "不平衡" "保存失败"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -9.00 CNY')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.locator('.ant-message')).toContainText('保存失败')
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
  }
})
