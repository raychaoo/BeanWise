import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface PythonSvcOptions {
  /** 引擎启动命令（含参数），如 ['py', '-3.11', 'python/service.py', '--stdio'] */
  command: string[]
  /** 单个 RPC 请求超时，默认 30_000 */
  requestTimeoutMs?: number
  /** shutdown 请求超时，默认 5_000 */
  shutdownTimeoutMs?: number
  /** 异常退出后首次重试延迟，默认 1_000 */
  initialRetryDelayMs?: number
  /** 重试延迟上限（指数退避），默认 30_000 */
  maxRetryDelayMs?: number
}

export class PythonSvcError extends Error {}

interface RpcEnvelope {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

interface ParseEntriesResult {
  entries: Array<Record<string, unknown> & { postings?: unknown[] }>
  errors: Array<{ type: string; message: string; filename?: string | null; lineno?: number | null }>
  options: Record<string, unknown>
}

/** Python 引擎 stdio JSON-RPC 客户端：惰性 spawn、带超时请求、异常退出指数退避重启、优雅关闭。 */
export class PythonSvc {
  private proc: ChildProcess | null = null
  private pending = new Map<number, (env: RpcEnvelope) => void>()
  private nextId = 1
  private retryDelay: number
  private retryTimer: NodeJS.Timeout | null = null
  private stopping = false
  private restartCountValue = 0

  constructor(private readonly options: PythonSvcOptions) {
    this.retryDelay = options.initialRetryDelayMs ?? 1_000
  }

  /** 已重启次数（异常退出触发，测试与日志用） */
  get restartCount(): number {
    return this.restartCountValue
  }

  /** 进程当前是否存活 */
  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  private ensureRunning(): void {
    if (this.proc !== null && this.proc.exitCode === null) return
    this.spawnProcess()
  }

  private spawnProcess(): void {
    // 清理挂起的退避 timer：退避窗口内的 ensureRunning/request 会直接 spawn，
    // 若不清掉，timer 触发时会再 spawn 一次并替换 this.proc → 前一个成为孤儿进程
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const [cmd, ...args] = this.options.command
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    this.proc = proc
    proc.stdin?.on('error', () => {}) // 进程提前退出时忽略管道错误
    proc.stdout?.on('error', () => {})
    proc.on('error', (err) => {
      // spawn 失败（如引擎二进制缺失 ENOENT）不触发 'exit'：必须按进程死亡处理——
      // 快速失败在途请求并调度重启，否则请求挂到超时、且无 listener 的 error 会抛未捕获异常
      if (this.proc !== proc) return // 迟到的 error（已在 exit 后重启）不误伤当前进程
      this.proc = null
      const svcErr = new PythonSvcError(`引擎进程启动失败（spawn: ${err.message}）`)
      for (const resolve of this.pending.values()) resolve({ id: 0, error: { code: -32603, message: svcErr.message } })
      this.pending.clear()
      this.scheduleRestart()
    })
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      let env: RpcEnvelope
      try {
        env = JSON.parse(line) as RpcEnvelope
      } catch {
        return // 非法行丢弃（引擎不应输出非 JSON）
      }
      const resolve = this.pending.get(env.id)
      if (resolve) {
        this.pending.delete(env.id)
        resolve(env)
      }
    })
    proc.on('exit', (code, signal) => {
      this.proc = null
      // 进程死了，所有在途请求直接失败
      const err = new PythonSvcError(`引擎进程退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      for (const resolve of this.pending.values()) resolve({ id: 0, error: { code: -32603, message: err.message } })
      this.pending.clear()
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopping || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.restartCountValue += 1
      this.spawnProcess()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, this.options.maxRetryDelayMs ?? 30_000)
  }

  /** 确保进程在跑（惰性：首次调用才 spawn） */
  async start(): Promise<void> {
    this.ensureRunning()
    // 等 3 次 ping 机会（最多 3s），让进程就绪
    for (let i = 0; i < 3; i++) {
      try {
        await this.request('ping', {}, 1_000)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    this.ensureRunning()
    const proc = this.proc
    if (!proc || proc.exitCode !== null) {
      return Promise.reject(new PythonSvcError('引擎进程不可用'))
    }
    const id = this.nextId++
    const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new PythonSvcError(`RPC 请求超时（${timeout}ms）：${method}`))
      }, timeout)
      this.pending.set(id, (env) => {
        clearTimeout(timer)
        if (env.error) {
          reject(new PythonSvcError(`RPC 错误 ${env.error.code}: ${env.error.message}`))
        } else {
          resolvePromise(env.result as T)
        }
      })
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  ping(): Promise<{ pong: boolean }> {
    return this.request('ping')
  }

  validate(filename: string): Promise<{ errors: ParseEntriesResult['errors'] }> {
    return this.request('validate', { filename })
  }

  parseFile(filename: string): Promise<{ entry_count: number; errors: ParseEntriesResult['errors']; options: ParseEntriesResult['options'] }> {
    return this.request('parse_file', { filename })
  }

  parseEntries(filename: string): Promise<ParseEntriesResult> {
    return this.request('parse_entries', { filename })
  }

  /** 优雅关闭：shutdown RPC → 等待退出 → 超时 kill 兜底 */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return
    try {
      await this.request('shutdown', {}, this.options.shutdownTimeoutMs ?? 5_000)
    } catch {
      // 进程已退出或 shutdown 失败，交给下方等待/兜底
    }
    await Promise.race([
      new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit())),
      new Promise<void>((resolveExit) => setTimeout(resolveExit, 1_000)) // 确认 shutdown 后正常引擎应立即退出，1s 仅为 kill 兜底等待
    ])
    if (proc.exitCode === null) proc.kill()
  }
}
