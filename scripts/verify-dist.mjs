#!/usr/bin/env node
/**
 * 打包产物校验（M14）：在 electron-builder 之后运行，把两类缺陷挡在「装上去才发现」之前。
 *
 * 为什么必须有这个脚本：dev / E2E / 单测**全部**走未打包分支（本机解释器 + 活源码，
 * 见 src/main/index.ts 的 resolveEngineCommand），所以下面两类问题在任何自动化检查里都不可见。
 * 两类都各坑过一次，且都只坑安装版：
 *
 *   1. 布局 —— extraResources 单文件源的 `to` 是目的**文件名**而非目录：`to: python/` 产出的是
 *      名为 `python` 的 13MB **文件**，安装后主进程找 resources/python/beancount-engine.exe 必 ENOENT。
 *   2. 陈旧 —— `dist-python/` 在 .gitignore 里且曾长期不随 dist:win 重建：装上去的是几周前的引擎，
 *      源码里后加的 RPC 方法一个都没有（表现为保存时报 -32601 未知方法: parse_entries）。
 *
 * 第 2 条不靠 mtime 判断（mtime 会被 checkout / 复制重置，不可靠），而是**把打包好的 exe 起起来**，
 * 对着 python/engine/rpc.py 的方法表逐个探活：返 -32601 就是方法不存在，返 -32602（参数不合）说明
 * 方法存在。方法表由源码正则抽取，以后往 rpc.py 加方法不需要改本脚本。
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const UNPACKED_DIR = resolve('dist/win-unpacked/resources/python')
const ENGINE = resolve(UNPACKED_DIR, 'beancount-engine.exe')
const RPC_SRC = resolve('python/engine/rpc.py')
const PROBE_TIMEOUT_MS = 30_000

const failures = []
const passed = []

/** 从 rpc.py 的 METHODS 字典抽方法名（正则，避免把 Python 解析器搬进来） */
function readMethodTable() {
  const source = readFileSync(RPC_SRC, 'utf8')
  const block = source.match(/METHODS\s*=\s*\{([\s\S]*?)\n\}/)
  if (!block) {
    failures.push(`无法从 ${RPC_SRC} 解析 METHODS 方法表（格式变了？本脚本要同步改）`)
    return []
  }
  return [...block[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1])
}

/** 起打包好的引擎，对每个方法发一次空参数请求，返回「方法不存在」的那些 */
function probeMissingMethods(methods) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(ENGINE, ['--stdio'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true
    })
    const waiters = []
    const timer = setTimeout(() => {
      proc.kill()
      rejectPromise(new Error(`探活超时（${PROBE_TIMEOUT_MS}ms）——引擎没有响应`))
    }, PROBE_TIMEOUT_MS)

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => waiters.shift()?.(line))
    proc.on('error', (err) => {
      clearTimeout(timer)
      rejectPromise(new Error(`无法启动引擎：${err.message}`))
    })

    const ask = (id, method) =>
      new Promise((res) => {
        waiters.push(res)
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n')
      })

    ;(async () => {
      const missing = []
      let id = 1
      for (const method of methods) {
        const line = await ask(id++, method)
        let envelope
        try {
          envelope = JSON.parse(line)
        } catch {
          continue // 非法行忽略（引擎不应输出非 JSON）
        }
        if (envelope.error?.code === -32601) missing.push(method)
        if (method === 'shutdown') break // shutdown 之后进程即退出，别等下一行
      }
      clearTimeout(timer)
      proc.kill()
      resolvePromise(missing)
    })().catch((err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })
  })
}

// ---- 1. 布局 ----
let engineStat = null
try {
  engineStat = statSync(ENGINE)
} catch {
  failures.push(
    `引擎产物缺失：${ENGINE} 不存在。` +
      `若 ${UNPACKED_DIR} 本身是个十几 MB 的**文件**而不是目录，就是 electron-builder.yml 的 extraResources` +
      `把单文件源的 to 写成了目录形式（必须写全文件名，见文件头注释 1）。`
  )
}
if (engineStat) {
  if (!engineStat.isFile()) {
    failures.push(`${ENGINE} 存在但不是普通文件`)
  } else if (engineStat.size < 1_000_000) {
    failures.push(`${ENGINE} 只有 ${engineStat.size} 字节，不像正常的引擎二进制（约 13MB）`)
  } else {
    passed.push(`布局：${ENGINE}（${(engineStat.size / 1048576).toFixed(1)} MB）`)
  }
}

// ---- 2. 打包二进制真的会说当前协议 ----
if (engineStat?.isFile()) {
  const methods = readMethodTable()
  if (methods.length > 0) {
    try {
      const missing = await probeMissingMethods(methods)
      if (missing.length > 0) {
        failures.push(
          `打包进去的引擎不认识这些方法：${missing.join(' / ')}。` +
            `几乎可以肯定是 dist-python/beancount-engine.exe 陈旧（它不随 dist:win 自动重建）——` +
            `跑 npm run build:python 后重新打包。`
        )
      } else {
        passed.push(`协议：${methods.length} 个方法全部探活通过（${methods.join(' ')}）`)
      }
    } catch (err) {
      failures.push(`协议探活失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// ---- 3. 安装包本体 ----
const setups = readdirSync('dist').filter((f) => /Setup.*\.exe$/i.test(f) && !f.endsWith('.blockmap'))
if (setups.length === 0) {
  failures.push('安装包缺失：dist/ 下没有 Setup*.exe')
} else {
  for (const name of setups) {
    const stat = statSync(resolve('dist', name))
    passed.push(`安装包：dist/${name}（${(stat.size / 1048576).toFixed(1)} MB）`)
  }
}

// ---- 汇总 ----
for (const line of passed) console.log(`  [ok] ${line}`)
if (failures.length > 0) {
  console.error('\n[verify-dist] 产物校验未通过：')
  for (const line of failures) console.error(`  [x] ${line}`)
  process.exit(1)
}
console.log('[verify-dist] 产物校验通过')
