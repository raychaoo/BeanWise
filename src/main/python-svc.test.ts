import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

  it('spawn 失败（ENOENT）快速失败：不挂起、isRunning 为 false、退避重启', async () => {
    // 不存在的可执行文件：spawn 触发 'error'（ENOENT）且永不触发 'exit'
    const svc = track(
      new PythonSvc({
        command: ['no-such-command-bw-xyz'],
        initialRetryDelayMs: 50,
        maxRetryDelayMs: 100
      })
    )
    await expect(svc.request('ping')).rejects.toThrow(/启动失败/)
    expect(svc.isRunning()).toBe(false)
    const deadline = Date.now() + 5_000
    while (svc.restartCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(svc.restartCount).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('退避窗口内的 request 只 spawn 一个进程（防双 spawn 孤儿）', async () => {
    const marker = join(tmpdir(), `bw-pysvc-marker-${Date.now()}.json`)
    rmSync(marker, { force: true })
    try {
      // 第一次运行写 marker 后退出 1（触发退避）；之后运行读到 marker 则存活（不响应 stdin）
      const script = `const fs=require('fs'),p=${JSON.stringify(marker)};try{fs.readFileSync(p);setInterval(()=>{},1000)}catch(e){fs.writeFileSync(p,'1');process.exit(1)}`
      const svc = track(
        new PythonSvc({
          command: ['node', '-e', script],
          initialRetryDelayMs: 500,
          maxRetryDelayMs: 500,
          shutdownTimeoutMs: 500
        })
      )
      await svc.start()
      // start() 的重试会在退避窗口内直接 spawn 新进程（清掉挂起的 timer）：
      // 修复前退避 timer 仍会触发第二次 spawn → restartCount 变为 1
      expect(svc.restartCount).toBe(0)
      expect(svc.isRunning()).toBe(true)
    } finally {
      rmSync(marker, { force: true })
    }
  }, 15_000)

  it('stop 优雅关闭：shutdown 后进程退出 0（真实引擎）', async () => {
    const svc = track(new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] }))
    await svc.ping()
    await svc.stop()
    expect(svc.isRunning()).toBe(false)
  }, 30_000)
})
