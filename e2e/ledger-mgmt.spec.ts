/**
 * 批次 H 账本管理卡 E2E：设置页 recents 列表操作菜单全链路。
 * 自建三个临时账本 → 打开顺序 A、C、B：B 为当前（门控），C 演练删除，A 演练重命名。
 * 交互顺序刻意安排（Electron+Playwright 实测约束）：
 *  ① 当前项门控最先（B 行在最上、首个下拉无遮挡；断言后点击卡片标题关闭弹层）；
 *  ② 删除其次（输入目录名确认；本地重拉列表，无整页导航）；
 *  ③ 重命名最后（成功后应用自身 window.location.reload()——该导航前后页面点击会
 *     wedge 会话，故其后只做 DOM/磁盘被动断言，不再有任何点击）。
 * Modal OK 按钮用 scoped class 定位（.ant-btn-dangerous/.ant-btn-primary）：
 * antd 对两字按钮文本自动插空格（「删 除」），文本 role 匹配不可靠。
 * 磁盘语义（白名单/重名拒绝/归档落位/current 保护）由 ipc-handlers-workspace.test.ts 单测覆盖。
 */
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { FIXTURE_SOURCE } from './fixtures/setup'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

/** 打开工作目录并整页 reload（对齐 smoke.spec activateWorkspace 范式） */
async function activateWorkspace(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (d) => {
    const opened = await window.beanwise.openWorkspace(d)
    if (!opened.ok) throw new Error(opened.message ?? '打开工作目录失败')
  }, dir)
  await win.reload()
}

test('设置页账本管理卡：当前项门控 + 输入目录名删除 + 重命名', async () => {
  test.setTimeout(180_000)
  const dirA = mkdtempSync(join(tmpdir(), 'beanwise-e2e-mgmt-a-'))
  copyFileSync(FIXTURE_SOURCE, join(dirA, 'main.beancount'))
  const dirC = mkdtempSync(join(tmpdir(), 'beanwise-e2e-mgmt-c-'))
  const dirB = mkdtempSync(join(tmpdir(), 'beanwise-e2e-mgmt-b-'))
  const nameA = basename(dirA)
  const nameB = basename(dirB)
  const nameC = basename(dirC)
  const renameTo = `${nameA}-r2`
  const renamedPath = join(dirname(dirA), renameTo)
  const cleanup = () => {
    for (const d of [dirA, dirC, dirB, renamedPath]) {
      rmSync(d, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 })
    }
  }
  try {
    const app = await electron.launch({ args: launchArgs })
    const win = await app.firstWindow()
    await activateWorkspace(win, dirA)
    await activateWorkspace(win, dirC)
    await activateWorkspace(win, dirB) // B 成为当前，A/C 留在 recents

    // 进入设置页（HashRouter 直达），账本管理卡渲染三个登记目录
    await win.evaluate(() => { window.location.hash = '#/settings' })
    await expect(win.getByText('账本管理')).toBeVisible()
    const menuA = win.getByRole('button', { name: `账本操作：${nameA}`, exact: true })
    const menuB = win.getByRole('button', { name: `账本操作：${nameB}`, exact: true })
    const menuC = win.getByRole('button', { name: `账本操作：${nameC}`, exact: true })
    await expect(menuA).toBeVisible()
    await expect(menuB).toBeVisible()
    await expect(menuC).toBeVisible()
    await expect(win.getByText('当前', { exact: true })).toBeVisible()

    // antd Dropdown 关闭后菜单仍驻留 DOM，菜单断言一律限定当前展开的下拉
    const visibleMenu = () => win.locator('.ant-dropdown:not(.ant-dropdown-hidden)')

    // ① 当前项（B）门控：打开/重命名/归档禁用、删除不出现（首个下拉）
    await menuB.click({ timeout: 8000 })
    await expect(visibleMenu().getByRole('menuitem', { name: '打开' })).toBeDisabled()
    await expect(visibleMenu().getByRole('menuitem', { name: '重命名' })).toBeDisabled()
    await expect(visibleMenu().getByRole('menuitem', { name: '归档' })).toBeDisabled()
    await expect(visibleMenu().getByRole('menuitem', { name: '删除' })).toHaveCount(0)
    // 点击卡片标题关闭弹层（标题位于 B 行上方，弹层向下展开不遮挡）
    await win.getByText('账本管理').click({ timeout: 8000 })

    // ② 删除 C（仅非 current）：输入目录名完全一致才启用确定 → 成功后列表本地刷新
    await menuC.click({ timeout: 8000 })
    await visibleMenu().getByRole('menuitem', { name: '删除' }).click({ timeout: 8000 })
    const deleteModal = () => win.locator('.ant-modal:has-text("删除账本")')
    const deleteOk = deleteModal().locator('button.ant-btn-dangerous')
    await expect(deleteOk).toBeDisabled()
    await win.getByPlaceholder(nameC).fill(nameC)
    await expect(deleteOk).toBeEnabled()
    await deleteOk.click({ timeout: 8000 })
    await expect(win.getByText('账本已删除')).toBeVisible()
    await expect(win.getByRole('button', { name: `账本操作：${nameC}`, exact: true })).toHaveCount(0)
    expect(existsSync(dirC)).toBe(false)
    await expect(menuB).toBeVisible()

    // ③ 重命名 A（最后一段交互：成功后应用自身 reload，之后仅被动断言）
    await menuA.click({ timeout: 8000 })
    await visibleMenu().getByRole('menuitem', { name: '重命名' }).click({ timeout: 8000 })
    const renameModal = () => win.locator('.ant-modal:has-text("重命名账本")')
    const renameInput = win.getByPlaceholder('新名称（中文/字母/数字/下划线/连字符）')
    await expect(renameInput).toHaveValue(nameA)
    await renameInput.fill(renameTo)
    await renameModal().locator('button.ant-btn-primary').click({ timeout: 8000 })
    // 应用自身 reload 落地后：hash 保持 /settings，列表原位显示新名（A 非 current，当前 Tag 仍在 B）
    await win.waitForTimeout(5000)
    await expect(win.getByRole('button', { name: `账本操作：${renameTo}`, exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(win.getByRole('button', { name: `账本操作：${nameA}`, exact: true })).toHaveCount(0)
    await expect(win.getByText('当前', { exact: true })).toBeVisible()
    expect(existsSync(renamedPath)).toBe(true)
    expect(existsSync(dirA)).toBe(false)

    await app.close()
  } finally {
    cleanup()
  }
})
