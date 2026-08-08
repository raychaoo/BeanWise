// postinstall：原生模块 rebuild 失败必须显式处理——CI 下 fail-loud，本机降级为警告。
// 背景：本机无 VS Build Tools 时 `electron-builder install-app-deps` 必然失败，
// 但 better-sqlite3 13.x 自带 in-tarball N-API prebuild（Node/Electron ABI 兼容），无需编译即可加载。
// 用 node 脚本而非 bash 内联，避免 npm 在 Windows 默认 cmd.exe 下无法执行 bash 语法。
import { spawnSync } from 'node:child_process'

// GitHub Actions（ubuntu / windows）等 CI 平台均会设置 CI=true
const isCI = Boolean(process.env.CI)

// npm 生命周期脚本会注入 npm_execpath（当前 npm-cli.js），复用同一 npm 实例，等价于
// `electron-builder install-app-deps`，不依赖 PATH / shell 差异
const npmCli = process.env.npm_execpath
if (!npmCli) {
  console.error('[postinstall] 未找到 npm_execpath，无法执行 install-app-deps')
  process.exit(isCI ? 1 : 0)
}

const result = spawnSync(
  process.execPath,
  [npmCli, 'exec', '--', 'electron-builder', 'install-app-deps'],
  { stdio: 'inherit' }
)

if (result.error || result.status !== 0) {
  const warning =
    '[postinstall] install-app-deps 失败已忽略（本机无 VS Build Tools；better-sqlite3 13.x N-API prebuild 免 rebuild）'
  if (isCI) {
    console.error('[postinstall] install-app-deps 失败，CI 环境不允许静默降级：')
    console.error(warning)
    process.exit(1)
  }
  console.warn(warning)
}
