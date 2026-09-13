import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'

// M2 引擎冒烟：spawn Python 引擎（stdio JSON-RPC）验证 ping / validate / shutdown
// 本机 Windows 用 py launcher（`python` 命令是 3.8 不可用），CI ubuntu 用 python3；
// 可用环境变量 BEANWISE_PYTHON_CMD 覆盖，如 'py -3.11' / 'python3'
const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

interface RpcResponse {
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface Engine {
  proc: ChildProcess
  request: (payload: unknown) => Promise<RpcResponse>
  stop: () => Promise<void>
}

function startEngine(): Engine {
  const proc = spawn(PYTHON[0], [...PYTHON.slice(1), SERVICE, '--stdio'], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  proc.stdin!.on('error', () => {}) // 进程提前退出时忽略管道错误
  proc.stdout!.on('error', () => {})
  const rl = createInterface({ input: proc.stdout! })
  const pending: Array<(value: RpcResponse) => void> = []
  rl.on('line', (line) => {
    pending.shift()?.(JSON.parse(line) as RpcResponse)
  })
  const request = (payload: unknown) =>
    new Promise<RpcResponse>((resolvePromise) => {
      pending.push(resolvePromise)
      proc.stdin!.write(JSON.stringify(payload) + '\n')
    })
  const stop = async () => {
    try {
      await request({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: {} })
    } catch {
      // 进程已退出则忽略
    }
    await Promise.race([
      new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit())),
      new Promise<void>((resolveExit) => setTimeout(resolveExit, 5000))
    ])
    if (proc.exitCode === null) proc.kill()
  }
  return { proc, request, stop }
}

describe('Python 引擎 stdio JSON-RPC 冒烟（M2）', () => {
  it('ping 往返返回 pong', async () => {
    const engine = startEngine()
    const res = await engine.request({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
    expect(res.result).toEqual({ pong: true })
    await engine.stop()
  })

  it('validate 合法账本返回空错误列表', async () => {
    const engine = startEngine()
    const res = await engine.request({
      jsonrpc: '2.0',
      id: 2,
      method: 'validate',
      params: { filename: FIXTURE }
    })
    expect(res.result).toEqual({ errors: [] })
    await engine.stop()
  })

  it('shutdown 优雅退出（exit 0）', async () => {
    const engine = startEngine()
    const exit = new Promise<number | null>((resolveExit) =>
      engine.proc.on('exit', (code) => resolveExit(code))
    )
    const res = await engine.request({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} })
    expect(res.result).toEqual({ shutdown: true })
    await expect(exit).resolves.toBe(0)
  })
}, 30_000)
