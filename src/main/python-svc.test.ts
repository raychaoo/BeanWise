import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PythonSvc } from './python-svc'

// 本机 Windows 用 py launcher（`python` 命令是 3.8 不可用），CI ubuntu 用 python3；
// 可用环境变量 BEANWISE_PYTHON_CMD 覆盖，如 'py -3.11' / 'python3'
const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

describe('PythonSvc 生命周期与 RPC（M3）', () => {
  const svcs: PythonSvc[] = []
  const track = (svc: PythonSvc) => {
    svcs.push(svc)
    return svc
  }
  afterEach(async () => {
    await Promise.all(svcs.splice(0).map((s) => s.stop()))
  })

  it('ping 往返 + parseEntries 返回结构化条目（真实引擎）', async () => {
    const svc = track(new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] }))
    await expect(svc.ping()).resolves.toEqual({ pong: true })

    const result = await svc.parseEntries(FIXTURE)
    expect(result.errors).toEqual([])
    const txs = result.entries.filter((e) => e.type === 'Transaction')
    expect(txs).toHaveLength(2)
    expect(txs[0].postings?.[0]).toEqual({
      account: 'Assets:Bank:CNB',
      units_number: '-15.00',
      units_currency: 'CNY',
      cost_number: null,
      cost_currency: null
    })
  }, 30_000)

  it('请求超时返回拒绝', async () => {
    // 不启动真实引擎：spawn 一个不响应 stdin 的进程，request 必超时
    const svc = track(new PythonSvc({ command: ['node', '-e', 'setInterval(() => {}, 1000)'], requestTimeoutMs: 300 }))
    await expect(svc.request('ping')).rejects.toThrow(/超时/)
  }, 10_000)

  it('异常退出后指数退避重启（假命令注入）', async () => {
    const svc = track(
      new PythonSvc({
        command: ['node', '-e', 'process.exit(1)'],
        initialRetryDelayMs: 50,
        maxRetryDelayMs: 100
      })
    )
    await svc.start()
    const deadline = Date.now() + 5_000
    while (svc.restartCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(svc.restartCount).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('stop 优雅关闭：shutdown 后进程退出 0（真实引擎）', async () => {
    const svc = track(new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] }))
    await svc.ping()
    await svc.stop()
    expect(svc.isRunning()).toBe(false)
  }, 30_000)
})
