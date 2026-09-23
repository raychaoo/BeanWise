/**
 * PythonSvc spawn 选项（M14 修复的回归闸）：**必须传 windowsHide: true**。
 *
 * 单独成文件：这里要 mock `node:child_process`，而同目录 python-svc.test.ts 的用例**依赖真实 spawn**
 * （假命令注入 + 真实引擎），两者不能共处一个模块作用域。
 *
 * 为什么值得钉死：引擎是 console 子系统可执行文件（python/service.spec `console=True`——stdio 服务
 * 不能用 windowed），而 Electron 是 GUI 子系统、没有控制台。Windows 在「无控制台的父进程创建 console
 * 子进程」时会新分配一个控制台窗口，且引擎常驻 → 黑窗口整场会话挂着。dev 下 Electron 继承终端控制台，
 * 子进程直接挂上去不新建窗口，所以**只有安装版暴露**；而「有没有黑窗口」没有任何自动化手段能观察到，
 * 于是退而钉住这个选项本身。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
// vi.mock 会被提升到所有 import 之前，静态 import 即可（工厂只引用 mock* 前缀变量，符合提升规则）
import { PythonSvc } from './python-svc'

const mockSpawnCalls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = []

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], options: Record<string, unknown>) => {
    mockSpawnCalls.push({ cmd, args, options })
    const proc = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      exitCode: number | null
      kill: () => void
    }
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.exitCode = null
    proc.kill = () => {
      proc.exitCode = 0
      proc.emit('exit', 0, null)
    }
    // 极简回环：任何请求都回 result，使 ping/stop 不落到超时兜底（本用例不测协议）
    let buf = ''
    proc.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line === '') continue
        const req = JSON.parse(line) as { id: number; method: string }
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { pong: true } })}\n`)
        if (req.method === 'shutdown') {
          // 延到宏任务再发 exit：stop() 在 await 之后才注册 once('exit')，
          // 同 tick 发会漏收 → stop 白等 1s 兜底
          setTimeout(() => {
            proc.exitCode = 0
            proc.emit('exit', 0, null)
          }, 0)
        }
      }
    })
    return proc
  }
}))

describe('PythonSvc spawn 选项（M14）', () => {
  it('spawn 引擎时 windowsHide 为 true（防安装版黑窗口）', async () => {
    const svc = new PythonSvc({ command: ['fake-engine', '--stdio'], shutdownTimeoutMs: 200 })
    await svc.ping() // 惰性 spawn：首次 request 才起进程
    expect(mockSpawnCalls).toHaveLength(1)
    expect(mockSpawnCalls[0]).toMatchObject({ cmd: 'fake-engine', args: ['--stdio'] })
    expect(mockSpawnCalls[0].options['windowsHide']).toBe(true)
    await svc.stop()
  }, 10_000)
})
