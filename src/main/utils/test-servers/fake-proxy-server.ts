/**
 * 进程内假 HTTP 代理（测试用）：**只记录 CONNECT 目标**并回 502，用来断言「请求确实走了代理」。
 *
 * 为什么需要它：验证代理是否生效没法靠真实 GitHub（要外网、要凭据、不确定），
 * 而「把 git URL 指向一个不存在的域名 + 代理指向本机假代理」能确定性地证明请求被送进了代理
 * ——假代理收到 `CONNECT <host>:443` 即算命中，全程零外网。
 *
 * 与 git-test-server.ts 同样是**非 test 模块**，供 git-network / git-sync 单测共用。
 */
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'

export interface FakeProxy {
  /** 代理地址（`http://127.0.0.1:<port>`） */
  url: string
  /** 收到的 CONNECT 目标（`host:port`，按到达顺序） */
  connects: string[]
  close(): Promise<void>
}

/**
 * @param opts.hang true = 收到 CONNECT 后**不回包也不断开**（造超时场景：调用方只能等到自己的
 *   超时兜底）。默认回 502（造「代理不可用」场景）。
 */
export async function startFakeProxy(opts: { hang?: boolean } = {}): Promise<FakeProxy> {
  const connects: string[] = []
  const open: Duplex[] = []
  const server = createServer((_req, res) => {
    res.writeHead(502)
    res.end('fake proxy: only CONNECT')
  })
  // 普通 HTTP 请求（非 CONNECT）直接 502；CONNECT 记录目标后按模式处置
  server.on('connect', (req, socket) => {
    connects.push(req.url ?? '')
    open.push(socket)
    if (!opts.hang) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    close: () => new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy() // 挂起模式下必须显式断，否则 close 会一直等
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}
