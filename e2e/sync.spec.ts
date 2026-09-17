/**
 * M6 E2E（T7）：git 同步三链路——本地裸仓 + 进程内 smart-HTTP 服务器（零网络/凭据）。
 *
 * ① 配置空仓 → 保存自动 push → 裸仓可见
 * ② 远端已有不同内容 → 配置即冲突 → 采用远端 → 完成合并 → 裸仓为最终
 * ③ 远端新增 → 手动拉取 → 文件更新 + 明细联动
 *
 * 与 brief 的偏差（已确立环境差异，M6-T1/T3/T6 定稿，均为实测约束）：
 * - 裸仓一律走 src/main/git-test-server.ts 的进程内 smart-HTTP 服务器（isomorphic-git 1.41.3
 *   无 file:// 本地传输）；e2e/fixtures/sync.ts 为薄 re-export（单一实现，避免两套 helper 漂移）。
 * - 配置 URL 为 http://127.0.0.1:<port>（validateConfigureParams 已放行回环 HTTP）。
 * - 链路 ① 的「保存自动 push」经编辑器保存路径驱动：保存后自动 push 实现于编辑器 save 链路
 *   （ledger.ts doSaveFile）；录入表单保存（addLedgerEntry）不触发 push——brief 原案按录入流程
 *   断言 '已同步到远端' 在现产品上必然超时（M6-T7 实测）。
 * - 冲突 merged 内容断言用「view-line 点击聚焦 + Control+End 滚底」（T6 实测：view-lines 顶部
 *   文本 ours/theirs 相同、scrollHeight 为 16777216 sentinel 不可用、容器点击不建立焦点）。
 * - 同步配置按工作目录持久化（.beanwise 跨 launch 存活）：每用例先 clearSync + reload
 *   复位到未配置态（T6 模式），保证用例间与历史运行残留互不污染。
 * - 链路 ② 由 e2e/conflict-t6.spec.ts（T6 临时验收 spec）整合而来，C-1 回归断言（merged 编辑器
 *   无条件渲染）随迁至此；conflict-t6.spec.ts 删除，不留重复冲突测试。
 * - M11 起同步范围是**文件集**（账本 + 账户库 + Excel 模板 + .gitignore）：冲突载荷为逐文件三态，
 *   冲突视图按文件分 tab（JSON 文件只做「采用本地 / 采用远端」二选一，不做手工编辑）。
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createBareRepo, readRemoteFile, remoteCommitCount, seedRemote, seedRemoteInit, startGitServer } from './fixtures/sync'
import { waitForLedgerReady, cleanupFixture, createFixtureCopy, seedAccountConfig } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

/** 账户库文件（结构对齐 JsonAccountConfigStore.save） */
function accountsJson(...entries: Array<{ id: number; name: string; value: string }>): string {
  return JSON.stringify({ accounts: entries.map((e) => ({ ...e, description: '' })) }, null, 2)
}
/** 仓库内路径一律正斜杠（git 语义），勿用 path.join */
const ACCOUNTS_REL = '.beanwise/accounts.json'
const accountsPathOf = (ledgerPath: string): string => join(dirname(ledgerPath), '.beanwise', 'accounts.json')
const localText = (ledgerPath: string, rel: string): string => readFileSync(join(dirname(ledgerPath), rel), 'utf8')

/** E2E 不复用全局工作目录：显式激活临时目录后重载（与 ledger-index 同模式，批次 A 补齐 hermetic） */
async function activateWorkspace(win: Page, ledgerPath: string): Promise<void> {
  await win.evaluate(async (path) => {
    const opened = await window.beanwise.openWorkspace(path)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dirname(ledgerPath))
  await waitForLedgerReady(win)
  await win.reload()
}

/** 清掉 electron-store 残留同步配置（跨测试持久化），重载回未配置态 */
async function resetSync(win: Page): Promise<void> {
  await win.evaluate(() => window.beanwise.clearSync())
  await win.reload()
  await expect(win.getByRole('button', { name: '配置同步' })).toBeVisible()
}

/** 打开同步设置 Modal 并配置本地裸仓（http://127.0.0.1:<port> + 任意 PAT；本地协议不校验凭据） */
async function configureSync(win: Page, url: string): Promise<void> {
  await win.getByRole('button', { name: '配置同步' }).click()
  await win.getByPlaceholder('https://github.com/yourname/beanwise').fill(url)
  await win.getByPlaceholder('ghp_...').fill('test-pat')
  await win.getByRole('button', { name: /并同步/ }).click()
  await expect(win.locator('.ant-message')).toContainText('同步配置成功')
  await expect(win.getByRole('dialog')).not.toBeVisible()
}

test('M6 绿灯：配置空仓 → 保存自动 push → 裸仓可见', async () => {
  test.setTimeout(120_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)
    await resetSync(win)
    await configureSync(win, server.url)
    await expect(win.locator('.ant-tag').filter({ hasText: 'main' })).toBeVisible()

    // 编辑器保存 → 自动 push（fire-and-forget，成功后 Toast 已同步到远端）
    await win.getByRole('menuitem', { name: '编辑器' }).click()
    await expect(win.locator('.editor-main .view-lines')).toContainText('Breakfast')
    await win.locator('.editor-main .monaco-editor').click()
    await win.keyboard.press('Control+End')
    await win.keyboard.type('\n2026-08-09 * "自动同步" "E2E 保存"\n  Expenses:Food  12.50 CNY\n  Assets:Bank:CNB  -12.50 CNY')
    await win.getByRole('button', { name: '保存' }).click()
    await expect(win.locator('.ant-message')).toContainText('已保存并校验通过')
    await expect(win.locator('.ant-message')).toContainText('已同步到远端')

    // 地面真相：本地文件 + 裸仓均含新交易
    expect(readFileSync(ledgerPath, 'utf8')).toContain('自动同步')
    await expect.poll(async () => ((await readRemoteFile(bareDir)) ?? '').includes('自动同步')).toBe(true)

    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})

test('M6 冲突：远端已有不同内容 → 配置即冲突 → 采用远端 → 完成合并推送', async () => {
  test.setTimeout(120_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  try {
    // 远端内容 = 本地 fixture 副本 + 追加合法交易（场景 C：unrelated + 内容不一致 → conflict，base=''）
    const remoteContent =
      readFileSync(ledgerPath, 'utf8') +
      '\n2026-08-09 * "远端已有" "接管"\n  Expenses:Food  3.00 CNY\n  Assets:Bank:CNB  -3.00 CNY\n'
    await seedRemoteInit(server.url, remoteContent)

    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)
    await resetSync(win)

    // 1. 配置同步 → 场景 C 冲突 → store 接管 + warning（configure 返回 false，设置弹窗保持打开）
    await win.getByRole('button', { name: '配置同步' }).click()
    await win.getByPlaceholder('https://github.com/yourname/beanwise').fill(server.url)
    await win.getByPlaceholder('ghp_...').fill('test-pat')
    await win.getByRole('button', { name: /并同步/ }).click()
    await expect(win.locator('.ant-message')).toContainText('请在三路合并视图处理')

    // 2. 「合并」菜单项出现 → 关闭设置弹窗 → 进入冲突视图
    await expect(win.getByRole('menuitem', { name: '合并' })).toBeVisible()
    await win.keyboard.press('Escape')
    await win.getByRole('menuitem', { name: '合并' }).click()

    // 3. C-1 回归：上双 Diff + 下 merged 编辑器均可见（T6 修复：merged 编辑器无条件渲染）
    await expect(win.locator('.conflict-diff .monaco-diff-editor')).toBeVisible()
    await expect(win.locator('.conflict-merged .monaco-editor')).toBeVisible()

    // 4. 采用远端 → merged 内容 = 远端（view-line 点击聚焦后 Ctrl+End 滚底，追加交易可见）
    await win.getByRole('button', { name: '采用远端' }).click()
    await win.locator('.conflict-merged .view-line').first().click()
    await win.keyboard.press('Control+End')
    await expect(win.locator('.conflict-merged .view-lines')).toContainText('远端已有')

    // 5. 完成合并 → 成功提示 + 冲突消失 + merged 编辑器仍在（无条件渲染，视图保活）
    await win.getByRole('button', { name: '完成合并' }).click()
    await expect(win.locator('.ant-message')).toContainText('冲突已解决并推送')
    await expect(win.getByRole('menuitem', { name: '合并' })).toHaveCount(0)
    await expect(win.locator('.conflict-diff .monaco-diff-editor')).toHaveCount(0)
    await expect(win.locator('.conflict-merged .monaco-editor')).toBeVisible()

    // 6. 地面真相：落盘文件与裸仓均为最终内容（= 采用远端的 theirs，含「远端已有」+ fixture 交易）
    expect(readFileSync(ledgerPath, 'utf8')).toContain('远端已有')
    await expect.poll(async () => ((await readRemoteFile(bareDir)) ?? '').includes('远端已有')).toBe(true)
    expect(await readRemoteFile(bareDir)).toContain('Breakfast')

    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})

test('M6 拉取：远端新增 → 手动拉取 → 文件更新 + 明细联动', async () => {
  test.setTimeout(120_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)
    await resetSync(win)
    await configureSync(win, server.url)

    // 远端新增一笔（模拟他人修改）
    await seedRemote(server.url,
      '\n2026-08-09 * "远端拉取" "快进"\n  Expenses:Food  6.00 CNY\n  Assets:Bank:CNB  -6.00 CNY\n')

    // 手动拉取：状态条「拉取」按钮（SyncStatusBar）→ 快进合并 → 落盘 + 索引重建
    await win.getByRole('button', { name: '拉取' }).click()
    await expect(win.locator('.ant-message')).toContainText('已拉取远端更新')
    expect(readFileSync(ledgerPath, 'utf8')).toContain('远端拉取')

    // 明细联动（pull 落盘 → refreshIndex → 明细可见远端交易）
    await win.getByRole('menuitem', { name: '明细' }).click()
    await expect(win.locator('.ant-table-tbody')).toContainText('远端拉取')

    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})

// ==================== M11：账户库 / Excel 模板随账本同步 ====================

/** 启动 → 激活工作目录 → 复位同步 → 配置裸仓（M11 三条链路的公共前置） */
async function launchConfigured(ledgerPath: string, url: string): Promise<{ app: Awaited<ReturnType<typeof electron.launch>>; win: Page }> {
  const app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
  })
  const win = await app.firstWindow()
  await activateWorkspace(win, ledgerPath)
  await resetSync(win)
  await configureSync(win, url)
  return { app, win }
}

test('M11 账户库：科目保存后自动 push，索引缓存与同步配置不进仓库', async () => {
  test.setTimeout(180_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  seedAccountConfig(ledgerPath, [{ id: 1, name: '吃饭', value: 'Expenses:Food' }])
  try {
    const { app, win } = await launchConfigured(ledgerPath, server.url)

    // 首同步已把账户库与托管 .gitignore 推送上去
    await expect.poll(async () => (await readRemoteFile(bareDir, ACCOUNTS_REL)) ?? '').toContain('Expenses:Food')
    expect(await readRemoteFile(bareDir, '.gitignore')).toContain('.beanwise/index.db')

    // 新增科目 → 保存 → 自动 push（saveAccountConfig 成功后触发 push）
    await win.getByRole('menuitem', { name: '账户' }).click()
    await expect(win.getByText('科目管理')).toBeVisible({ timeout: 20000 })
    await win.getByRole('button', { name: '新增科目' }).click()
    await win.getByPlaceholder('名称（中文）').fill('房租')
    await win.getByPlaceholder('路径 如 Bank:CNB').fill('Assets:Rent')
    await win.getByRole('button', { name: '添加' }).click()
    await win.getByRole('button', { name: /保\s*存/ }).click()
    await expect(win.locator('.ant-message')).toContainText('账户配置已保存')
    await expect(win.locator('.ant-message')).toContainText('已同步到远端')

    await expect.poll(async () => (await readRemoteFile(bareDir, ACCOUNTS_REL)) ?? '').toContain('Assets:Rent')
    // 缓存/本机元数据被托管忽略规则挡住：不进仓库
    expect(await readRemoteFile(bareDir, '.beanwise/index.db')).toBeNull()
    expect(await readRemoteFile(bareDir, '.beanwise/sync-config.json')).toBeNull()

    // 无改动的重复同步不再产生空提交（旧实现因 index.db 未跟踪而每次都提交）
    await win.getByRole('menuitem', { name: '账户' }).click()
    const before = await remoteCommitCount(bareDir)
    await win.getByRole('button', { name: /保\s*存/ }).click()
    await expect(win.locator('.ant-message')).toContainText('已同步到远端')
    expect(await remoteCommitCount(bareDir)).toBe(before)

    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})

test('M11 拉取：远端账户库更新 → 拉取 → 账户页联动出现新科目', async () => {
  test.setTimeout(180_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  seedAccountConfig(ledgerPath, [{ id: 1, name: '吃饭', value: 'Expenses:Food' }])
  try {
    const { app, win } = await launchConfigured(ledgerPath, server.url)

    // 远端他人改了账户库（新增科目名）
    await seedRemote(server.url, {
      [ACCOUNTS_REL]: accountsJson({ id: 1, name: '吃饭', value: 'Expenses:Food' }, { id: 2, name: '房租', value: 'Expenses:Rent' })
    })

    await win.getByRole('button', { name: '拉取' }).click()
    await expect(win.locator('.ant-message')).toContainText('已拉取远端更新')
    expect(localText(ledgerPath, ACCOUNTS_REL)).toContain('Expenses:Rent')

    // 账户页联动（pull → loadAccounts + generation 重载）
    await win.getByRole('menuitem', { name: '账户' }).click()
    await expect(win.getByText('科目管理')).toBeVisible({ timeout: 20000 })
    // 断言路径列（名称列是 Input，value 不在 DOM 文本里——toContainText 查的是 textContent）
    await expect(win.locator('.ant-table-tbody')).toContainText('Expenses:Rent', { timeout: 20000 })

    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})

test('M11 JSON 冲突：账户库同科目两侧改动 → 冲突 tab 二选一 → 完成合并推送', async () => {
  test.setTimeout(180_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  const accountsPath = accountsPathOf(ledgerPath)
  seedAccountConfig(ledgerPath, [{ id: 1, name: '吃饭', value: 'Expenses:Food' }])
  try {
    const { app, win } = await launchConfigured(ledgerPath, server.url)

    // 远端改同名科目；本地也改（不同内容）→ 同一条目两侧都改 → JSON 结构化并集无法解决
    await seedRemote(server.url, { [ACCOUNTS_REL]: accountsJson({ id: 1, name: '餐费', value: 'Expenses:Food' }) })
    writeFileSync(accountsPath, accountsJson({ id: 1, name: '吃饭啦', value: 'Expenses:Food' }), 'utf8')

    // 拉取前置快照提交本地改动 → fetch → 冲突（账户库一条）
    await win.getByRole('button', { name: '拉取' }).click()
    await expect(win.locator('.ant-message')).toContainText('同步冲突（账户库）')
    await expect(win.getByRole('menuitem', { name: '合并' })).toBeVisible()
    await win.getByRole('menuitem', { name: '合并' }).click()

    // JSON 冲突：无 merged 编辑器（display:none），且未选择前「完成合并」禁用
    await expect(win.getByRole('tab', { name: /账户库/ })).toBeVisible()
    await expect(win.locator('.conflict-diff .monaco-diff-editor')).toBeVisible()
    await expect(win.locator('.conflict-merged .monaco-editor')).toBeHidden()
    await expect(win.getByRole('button', { name: '完成合并' })).toBeDisabled()

    await win.getByRole('button', { name: '采用远端' }).click()
    await expect(win.getByRole('button', { name: '完成合并' })).toBeEnabled()
    await win.getByRole('button', { name: '完成合并' }).click()
    await expect(win.locator('.ant-message')).toContainText('冲突已解决并推送')

    expect(localText(ledgerPath, ACCOUNTS_REL)).toContain('餐费')
    await expect.poll(async () => (await readRemoteFile(bareDir, ACCOUNTS_REL)) ?? '').toContain('餐费')

    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})
