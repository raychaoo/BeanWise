#!/usr/bin/env node
// 运行 PyInstaller 打包 Beancount 引擎（输出 dist-python/，CLAUDE.md 约束 #5）
// 解释器解析：Windows 优先 py launcher 的 3.11（本机 `python` 命令是 3.8，不可用），
// 其他平台 python3；逐个降级，全部失败时打印原因。
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const spec = resolve(process.cwd(), 'python/service.spec')
const candidates =
  process.platform === 'win32'
    ? [
        ['py', '-3.11', '-m', 'PyInstaller'],
        ['python', '-m', 'PyInstaller']
      ]
    : [
        ['python3', '-m', 'PyInstaller'],
        ['python', '-m', 'PyInstaller']
      ]

let ranAny = false
for (const cmd of candidates) {
  const result = spawnSync(cmd[0], [...cmd.slice(1), spec, '--noconfirm'], { stdio: 'inherit' })
  if (result.status === 0) {
    process.exit(0)
  }
  if (!result.error) {
    ranAny = true // 进程已实际运行（spawn 成功），失败属构建阶段而非解释器缺失
  }
  const reason = result.error ? result.error.message : `退出码 ${result.status}`
  console.warn(`[build-python] ${cmd.join(' ')} 失败：${reason}`)
}

if (ranAny) {
  console.error('[build-python] PyInstaller 构建失败（见上方原因）')
} else {
  console.error('[build-python] 打包失败：未找到可用解释器，请确认 Python 3.11 已安装且 pip install pyinstaller')
}
process.exit(1)
