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
 * - M12 起可在同步设置里配**机器级**代理与超时（electron-store `git-network`）。该配置同样跨运行
 *   持久化，故 resetSync 一并复位；目标为本机回环时一律绕过代理——最后一条用例把这条钉死。
 * - M13 起提交人身份可手填（机器级，跨运行持久化 → resetSync 一并复位）或用 PAT 自动识别
 *   （打 `BEANWISE_GITHUB_API_BASE_URL` 指向的进程内假 GitHub，零外网）。两条用例都用
 *   `readLocalHeadAuthor` 读**真实 commit 对象**，把「设置 → store → GitSync → commit」整条装配钉死；
 *   断言对象是用例**自己造的新提交**（改一次账本 + push 的前置快照提交），不是 `workspace:open`
 *   的旧 `init:` 提交——后者早于身份设置，曾据此误判过一次。
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createBareRepo, readLocalHeadAuthor, readRemoteFile, remoteCommitCount, seedRemote, seedRemoteInit, startFakeGitHub, startGitServer } from './fixtures/sync'
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

/** 复位同步相关残留（跨用例 + 跨运行持久化）：本工作目录的配置/PAT + **机器级**网络与身份配置 */
async function resetSync(win: Page): Promise<void> {
  await win.evaluate(async () => {
    await window.beanwise.clearSync()
    await window.beanwise.saveGitNetwork({ proxyUrl: null, timeoutSec: 30 })
    // M13：手填提交人是**机器级**且跨运行持久化（同 M12 的网络配置），必须一并复位；
    // 识别缓存按工作目录隔离，而每个用例都是全新临时目录 → 天然为空，无需清理。
    await window.beanwise.saveGitIdentity({ name: null, email: null })
  })
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

// ==================== M12：本机代理与超时 ====================

test('M12 网络：保存本机代理与超时；配了代理也不影响回环仓库同步', async () => {
  test.setTimeout(180_000)
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

    // 1. 未配置态打开同步设置 → 网络区填「死端口」代理 + 超时 45s → 保存并回读
    await win.getByRole('button', { name: '配置同步' }).click()
    await win.getByPlaceholder('http://127.0.0.1:7890').fill('http://127.0.0.1:1')
    await win.getByRole('spinbutton').fill('45')
    await win.getByRole('button', { name: '保存网络设置' }).click()
    await expect(win.locator('.ant-message')).toContainText('网络设置已保存')
    expect(await win.evaluate(() => window.beanwise.getGitNetwork()))
      .toEqual({ proxyUrl: 'http://127.0.0.1:1', timeoutSec: 45 })

    // 2. 还没填仓库地址就测试连接 → 明确告知缺什么，而不是含糊的「超时」
    await win.getByRole('button', { name: '测试连接' }).click()
    await expect(win.getByText('请先填写并保存仓库地址')).toBeVisible()

    // 3. 关键回归：代理指向死端口，但仓库是回环测试服务器 → 必须绕过代理，配置并同步照常成功
    //    （把「回环绕过」这条规则钉死在端到端链路上，否则将来删掉它会静默搞垮全部同步测试）
    await win.getByPlaceholder('https://github.com/yourname/beanwise').fill(server.url)
    await win.getByPlaceholder('ghp_...').fill('test-pat')
    await win.getByRole('button', { name: /并同步/ }).click()
    await expect(win.locator('.ant-message')).toContainText('同步配置成功')
    expect(readFileSync(ledgerPath, 'utf8')).toContain('Breakfast')
    await expect.poll(async () => ((await readRemoteFile(bareDir)) ?? '').includes('Breakfast')).toBe(true)

    await app.close()
  } finally {
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})

// ==================== M13：提交人身份 ====================

const MANUAL_AUTHOR = { name: 'Zhang San', email: '42+zhangsan@users.noreply.github.com' }

/** 已配置态下重开同步设置（配置成功后弹窗会关闭，设置页有常驻入口） */
async function reopenSyncSettings(win: Page): Promise<void> {
  await win.evaluate(() => { window.location.hash = '#/settings' })
  await expect(win.getByText('账本管理')).toBeVisible()
  await win.getByRole('button', { name: '同步设置' }).click()
  await expect(win.getByRole('dialog')).toBeVisible()
}

test('M13 身份：手填提交人 → 生效值变手填，且真实 commit 对象的 author/committer 都是它', async () => {
  test.setTimeout(120_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const ledgerPath = createFixtureCopy()
  // app 提到 try 外、在 finally 里关：断言失败时若不关，`cleanupFixture` 会因 Electron 仍占着
  // SQLite/文件句柄而耗尽重试窗口，把一条断言错误变成一条「测试超时」——排查成本天差地别。
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)
    await resetSync(win)

    // 1. 未配置态打开同步设置 → 身份区填姓名+邮箱 → 保存并回读生效值
    await win.getByRole('button', { name: '配置同步' }).click()
    await win.getByPlaceholder('Zhang San').fill(MANUAL_AUTHOR.name)
    await win.getByPlaceholder('you@users.noreply.github.com').fill(MANUAL_AUTHOR.email)
    await win.getByRole('button', { name: '保存提交人信息' }).click()
    await expect(win.locator('.ant-message')).toContainText('提交人身份已保存')
    // 只读的「当前提交人」行必须立刻反映手填值（来源标注「手填」）
    await expect(win.getByText(/当前提交人：Zhang San/)).toContainText('42+zhangsan@users.noreply.github.com')
    await expect(win.getByText('（手填）')).toBeVisible()
    const state = await win.evaluate(() => window.beanwise.getGitIdentity())
    expect(state.manual).toEqual(MANUAL_AUTHOR)
    expect(state.effective).toEqual({ ...MANUAL_AUTHOR, source: 'manual' })

    // 2. 配置同步（回环仓库地址 → 不触发尾随自动识别）
    await win.getByPlaceholder('https://github.com/yourname/beanwise').fill(server.url)
    await win.getByPlaceholder('ghp_...').fill('test-pat')
    await win.getByRole('button', { name: /并同步/ }).click()
    await expect(win.locator('.ant-message')).toContainText('同步配置成功')

    // 3. 读**真实 commit 对象**验证整条装配（设置 → 机器级 store → GitSync.identity → commit）。
    //    必须自己造一个新提交：`workspace:open` 那个 `init:` 提交早于本用例保存身份，
    //    configure 又没有内容可提交（工作区干净）→ HEAD 会停在旧提交上（曾因此误判过一次）。
    //    push 的前置快照提交（snapshotLocal）一定走 GitSync.identity，故改一次账本再 push。
    appendFileSync(
      ledgerPath,
      '\n2026-09-18 * "身份" "E2E 提交人"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n'
    )
    await win.evaluate(() => window.beanwise.pushLedger())
    const head = await readLocalHeadAuthor(dirname(ledgerPath))
    expect(head.author).toEqual(MANUAL_AUTHOR)
    expect(head.committer).toEqual(MANUAL_AUTHOR)

    // 4. 清空手填 → 回落内置兜底（不留半截身份）
    await reopenSyncSettings(win)
    await win.getByPlaceholder('Zhang San').fill('')
    await win.getByPlaceholder('you@users.noreply.github.com').fill('')
    await win.getByRole('button', { name: '保存提交人信息' }).click()
    await expect(win.getByText(/当前提交人：BeanWise/)).toContainText('beanwise@local')
  } finally {
    if (app) await app.close().catch(() => undefined)
    await cleanupFixture(ledgerPath)
    await server.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})

test('M13 身份：用 PAT 识别 GitHub 身份（假 GitHub 服务器）→ 生效值变 noreply 身份', async () => {
  test.setTimeout(120_000)
  const bareDir = await createBareRepo()
  const server = await startGitServer(bareDir)
  const fakeApi = await startFakeGitHub()
  const ledgerPath = createFixtureCopy()
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      args: launchArgs,
      env: {
        ...process.env,
        BEANWISE_LEDGER_PATH: ledgerPath,
        // 只由主进程读；渲染端拿不到也传不了（否则等于给出「把 PAT 发到任意地址」的原语）
        BEANWISE_GITHUB_API_BASE_URL: fakeApi.url
      }
    })
    const win = await app.firstWindow()
    await activateWorkspace(win, ledgerPath)
    await resetSync(win)
    // 回环仓库地址 → configure 的尾随自动识别被跳过（保证同步链路零外连），识别走下面的按钮
    await configureSync(win, server.url)

    await reopenSyncSettings(win)
    await expect(win.getByText(/当前提交人：BeanWise/)).toBeVisible() // 识别前仍是兜底
    await win.getByRole('button', { name: '识别 GitHub 身份' }).click()
    await expect(win.getByText('已识别 GitHub 身份：koko')).toBeVisible()

    // 生效值 = GitHub 身份：昵称 + ID 形式的 noreply 邮箱；识别结果已按本工作目录缓存
    const state = await win.evaluate(() => window.beanwise.getGitIdentity())
    expect(state.effective).toEqual({
      name: 'Koko Zhang',
      email: '42+koko@users.noreply.github.com',
      source: 'pat'
    })
    expect(state.detected?.login).toBe('koko')
    await expect(win.getByText(/当前提交人：Koko Zhang/)).toContainText('42+koko@users.noreply.github.com')
    // 识别请求带着 PAT 与必需 UA（GitHub API 缺 UA 直接 403）
    expect(fakeApi.requests[0]?.authorization).toBe('Bearer test-pat')
    expect(fakeApi.requests[0]?.userAgent).toBe('BeanWise')

    // 识别出的身份也要真的进 commit 对象（这是绝大多数用户的默认路径）
    appendFileSync(
      ledgerPath,
      '\n2026-09-18 * "身份" "E2E 识别"\n  Expenses:Food  2.00 CNY\n  Assets:Bank:CNB  -2.00 CNY\n'
    )
    await win.evaluate(() => window.beanwise.pushLedger())
    const head = await readLocalHeadAuthor(dirname(ledgerPath))
    expect(head.author).toEqual({ name: 'Koko Zhang', email: '42+koko@users.noreply.github.com' })
    expect(head.committer).toEqual({ name: 'Koko Zhang', email: '42+koko@users.noreply.github.com' })
  } finally {
    if (app) await app.close().catch(() => undefined)
    await cleanupFixture(ledgerPath)
    await server.close()
    await fakeApi.close()
    rmSync(bareDir, { recursive: true, force: true })
  }
})
