/**
 * E2E 全局前置：先构建，再跑用例。
 *
 * Playwright 启动的是 `package.json` 的 `main`——`out/main/index.js`，渲染端由
 * `win.loadFile(join(import.meta.dirname, '../renderer/index.html'))` 从 `out/renderer/` 读，
 * 即**两端跑的都是构建产物、不是源码**。于是直接 `npx playwright test` 跑的是上一次的 `out/`：
 * 改了渲染端代码，断言仍按旧 bundle 结果，现象与「改动没生效」完全一样——曾据此白跑一轮，
 * 而且当时 `out/` 两半不同步（主进程数据是新的、渲染端还是旧 UI），越查越像组件没渲染。
 * `npm run test:e2e` 里的 `npm run build &&` 只护住了那一条入口，`npx playwright test` 绕过了它。
 *
 * 收进 globalSetup 后所有入口共用（`npx playwright test` / `npm run test:e2e` / `--ui`），
 * 且每次调用只构建一次：约 6 秒，相对两分钟的用例可忽略。构建失败会直接中断整轮用例，
 * 不会拿半新半旧的 `out/` 给出结论。
 */
import { execSync } from 'node:child_process'

export default function globalSetup(): void {
  execSync('npm run build', { stdio: 'inherit' })
}
