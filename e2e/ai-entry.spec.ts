/**
 * M7 E2E（T6）：AI 录入两链路——进程内 DeepSeek mock（BEANWISE_AI_BASE_URL 注入，零网络/零密钥）。
 * ① 绿灯：未配置隐藏入口 → 配置 Key → 自然语言 → 草稿 → 填入表单 → 提交落盘 → 文件/明细可见
 * ② 拒绝：mock 非法输出 → 「AI 输出不符合录入格式」提示 + 文件不变
 *
 * 环境事实（与 brief 的偏差，M7-T6 实测确立）：
 * - AI 配置经 electron-store 持久化（userData 跨 launch 存活），每用例先 clearAiConfig + reload
 *   复位（M6 resetSync 同模式）。
 * - AiEntryPanel Collapse 默认折叠且折叠态不渲染内容（antd v5）：每用例展开后再断言面板内容
 *   （openAiPanel；T5 交付即此行为，不改产品代码）。
 * - antd Button autoInsertSpaceInButton：两字中文无图标按钮可访问名含空格（「保存」→「保 存」），
 *   设置 Modal 保存按钮以 /保\s*存/ 匹配（getByRole 只见可见元素，隐藏的编辑器「保存」不干扰）。
 * - App.tsx 四视图常驻挂载（display:none 隐藏），getByText 会命中隐藏 DOM：草稿卡与明细表可
 *   同时含同一 narration → 草稿断言作用域 .ant-collapse-content、明细断言作用域 .ant-table-tbody
 *   （M6 sync 同模式）。
 * - SQLite 索引按 userData 持久化，启动重建为 fire-and-forget：渲染端首轮 refresh 可能读到
 *   上一运行残留行（隐藏明细表暂含历史写入交易，重建落盘后自愈）——只断言写入后可见，不断言
 *   「表内无某交易」。
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { chatCompletion, startAiServer, type AiServer } from './fixtures/ai'
import { waitForLedgerReady, cleanupFixture, createFixtureCopy } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

/** E2E 不复用全局工作目录：显式激活临时目录后重载（与 ledger-index 同模式，批次 A 补齐 hermetic） */
async function activateWorkspace(win: Page, ledgerPath: string): Promise<void> {
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  await waitForLedgerReady(win)
  await win.reload()
}

/** 清掉 electron-store 残留 AI 配置（跨测试持久化），重载回未配置态 */
async function resetAi(win: Page): Promise<void> {
  await win.evaluate(() => window.beanwise.clearAiConfig())
  await win.reload()
}

/** 批次 B：AI 面板移入 Drawer——先点页头「AI 录入」开抽屉，再展开面板自身折叠头 */
async function openAiPanel(win: Page): Promise<void> {
  await win.getByRole('button', { name: /AI 录入/ }).click()
  await win.getByRole('button', { name: /AI 辅助录入/ }).click()
}

/** 打开 AI 设置 Modal 并保存 Key（mock 端点不校验凭据） */
async function configureAi(win: Page): Promise<void> {
  await win.getByRole('button', { name: 'AI 设置' }).click()
  await win.getByPlaceholder('sk-...').fill('sk-test')
  await win.getByRole('button', { name: /保\s*存/ }).click()
  await expect(win.locator('.ant-message')).toContainText('AI 配置已保存')
  await expect(win.getByRole('dialog')).not.toBeVisible()
}

test('M7 绿灯：自然语言 → 草稿 → 填表确认 → 落盘全链路', async () => {
  test.setTimeout(120_000)
  const ai = await startAiServer()
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath, BEANWISE_AI_BASE_URL: ai.url }
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)
    await resetAi(win)
    // 批次 A 路由化：默认路由为总览，AI 录入面板位于「录入」页
    await win.getByRole('menuitem', { name: '录入' }).click()

    // 1. 未配置 → 整个 AI 录入入口隐藏
    await expect(win.getByRole('button', { name: /AI 辅助录入/ })).not.toBeVisible()

    // 2. 配置 Key → 入口出现
    await configureAi(win)
    await openAiPanel(win)

    // 3. 生成草稿（mock 返回固定合法交易）→ 草稿卡可见（作用域 collapse：明细表可能含同名行）
    await win.getByPlaceholder('例如：昨天午饭花了 25.5 元，用银行卡支付').fill('午饭 25.5 元')
    await win.getByRole('button', { name: '生成草稿' }).click()
    await expect(win.locator('.ant-collapse-content')).toContainText('E2E 生成的交易')

    // 4. 填入表单 → ProForm 回填 → 现有提交按钮落盘（写路径唯一）
    await win.getByRole('button', { name: '填入表单' }).click()
    await expect(win.locator('.ant-message')).toContainText('已填入表单')
    await win.getByRole('button', { name: '写入账本' }).click()
    await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')

    // 5. 地面真相：文件 + 明细视图均含新交易（明细断言作用域表格：草稿卡仍在 DOM 中）
    expect(readFileSync(ledgerPath, 'utf8')).toContain('E2E 生成的交易')
    await win.getByRole('menuitem', { name: '明细' }).click()
    await expect(win.locator('.ant-table-tbody')).toContainText('E2E 生成的交易')

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
    await ai.close()
  }
})

test('M7 拒绝：mock 非法输出 → 校验拒绝提示 + 文件不变', async () => {
  test.setTimeout(120_000)
  const ai = await startAiServer()
  // 非法输出：金额非十进制 + 日期格式非法
  ai.setResponder(() => ({
    status: 200,
    json: chatCompletion(JSON.stringify({
      entries: [{
        date: '2026-13-40',
        postings: [
          { account: 'Expenses:Food', number: 'abc', currency: 'CNY' },
          { account: 'Assets:Bank:CNB', number: '-25.50', currency: 'CNY' }
        ]
      }]
    }))
  }))
  const ledgerPath = createFixtureCopy()
  const before = readFileSync(ledgerPath, 'utf8')
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath, BEANWISE_AI_BASE_URL: ai.url }
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)
    await resetAi(win)
    // 批次 A 路由化：先进「录入」页（AI 面板所在路由）
    await win.getByRole('menuitem', { name: '录入' }).click()
    await configureAi(win)
    await openAiPanel(win)

    await win.getByPlaceholder('例如：昨天午饭花了 25.5 元，用银行卡支付').fill('午饭 25.5 元')
    await win.getByRole('button', { name: '生成草稿' }).click()

    // 校验拒绝提示（绿灯「schema 校验拒绝非法输出」的 UI 落点）
    await expect(win.getByText(/AI 输出不符合录入格式/)).toBeVisible()
    // 无草稿卡、无写入
    await expect(win.getByRole('button', { name: '填入表单' })).not.toBeVisible()
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before)

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
    await ai.close()
  }
})
