/**
 * M13：进程内假 GitHub API 服务器（单测与 E2E 共用，零外网）。
 *
 * 用途：覆盖「用 PAT 识别身份」的完整链路——真实 HTTP + 真实 JSON 解析 + 真实请求头断言，
 * 不必碰 api.github.com。地址是回环，`proxyAgentFor` 对回环恒直连，故这条路不需要代理；
 * 想验证「识别请求真的走了代理」用 `fake-proxy-server.ts` 的 startFakeProxy（见 git-identity.test.ts）。
 *
 * E2E 里配 `BEANWISE_GITHUB_API_BASE_URL` 指向本服务器（deps 注入，见 ipc-handlers-sync）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeGitHubRequest {
  method: string
  url: string
  authorization: string | undefined
  userAgent: string | undefined
  accept: string | undefined
}

export interface FakeGitHub {
  /** 形如 http://127.0.0.1:<port>（不含 /user 路径） */
  url: string
  /** 收到的请求（按到达顺序），用于断言凭据与必需请求头真的发出去了 */
  requests: FakeGitHubRequest[]
  /** 改下一次响应的状态与体（默认 200 + 一份合法用户 JSON） */
  setResponse(status: number, body: string): void
  close(): Promise<void>
}

/** 默认响应：一份形状合法的 `GET /user`（昵称可为 null，此处给非空值） */
export const FAKE_GITHUB_USER = { login: 'koko', id: 42, name: 'Koko Zhang' }

export async function startFakeGitHub(opts: { status?: number; body?: string } = {}): Promise<FakeGitHub> {
  let status = opts.status ?? 200
  let body = opts.body ?? JSON.stringify(FAKE_GITHUB_USER)
  const requests: FakeGitHubRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers['authorization'] as string | undefined,
      userAgent: req.headers['user-agent'] as string | undefined,
      accept: req.headers['accept'] as string | undefined
    })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setResponse: (nextStatus, nextBody) => {
      status = nextStatus
      body = nextBody
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
