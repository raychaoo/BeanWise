/**
 * M12：git 同步的本机代理与超时——`http` 插件包装（同步链路的**唯一**代理注入面）。
 *
 * 机制（实测 1.41.3）：isomorphic-git 的**顶层命令**（clone/fetch/push/listServerRefs）不接受
 * `agent` 参数，但 **HTTP 插件层接受**并透传给 simple-get
 * （`node_modules/isomorphic-git/http/node/index.js:187-212`，`get({...fetchOptions, url, method,
 * headers, agent, body}, cb)`），而 isomorphic-git 内部调插件时只传 `{onProgress, method, url,
 * headers}`、**不传 agent**。故代理只能在插件外面包一层。
 * 该模块不读任何环境变量代理（HTTP_PROXY 等），代理地址由用户在同步设置里手填。
 *
 * 回环绕过：目标 host 是本机回环（127.0.0.1 / localhost / ::1）时一律直连——否则配了代理会连
 * 测试用的进程内 git 服务器都走代理，单测/E2E 全灭。这条规则有专门测试锁死。
 *
 * 只支持 HTTP/HTTPS 代理（`https-proxy-agent`，CONNECT 隧道 + 按**目标 host** 做 TLS SNI）；
 * SOCKS 与企业代理认证不在本次范围。代理地址**不允许携带用户名密码**——密钥只进 safeStorage，
 * 而本配置是明文存的普通设置。
 */
import { HttpsProxyAgent } from 'https-proxy-agent'
import nodeHttp from 'isomorphic-git/http/node'
import type { HttpClient, GitHttpRequest, GitHttpResponse } from 'isomorphic-git/http/node'
import { GIT_TIMEOUT_SEC_DEFAULT, GIT_TIMEOUT_SEC_MAX, GIT_TIMEOUT_SEC_MIN } from '../../shared/ipc'
import type { GitNetworkConfig } from '../../shared/ipc'

const MAX_PROXY_URL_LEN = 200

export function defaultGitNetwork(): GitNetworkConfig {
  return { proxyUrl: null, timeoutSec: GIT_TIMEOUT_SEC_DEFAULT }
}

/**
 * 代理地址校验 + 规范化：空 → null（直连）；合法 → `url.origin`（丢 path/query）。
 * 非法一律抛中文 Error（IPC 层会把它转成 ok:false 的 error 文案）。
 */
export function parseProxyUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw new Error('代理地址必须是字符串')
  const text = raw.trim()
  if (text === '') return null
  if (text.length > MAX_PROXY_URL_LEN) throw new Error(`代理地址不能超过 ${MAX_PROXY_URL_LEN} 字符`)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('代理地址无法解析，正确写法如 http://127.0.0.1:7890')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 HTTP/HTTPS 代理地址（如 http://127.0.0.1:7890）')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('代理地址不要携带用户名密码（本机代理通常无需认证）')
  }
  if (url.hostname === '' || url.port === '' || Number(url.port) < 1) {
    throw new Error('代理地址需带端口（1~65535），如 http://127.0.0.1:7890')
  }
  return url.origin
}

/** 校验并补默认值（代理可空、超时缺省 30s）；超时必须是 1~600 的整数秒 */
export function normalizeGitNetwork(raw: unknown): GitNetworkConfig {
  const p = (raw ?? {}) as Partial<GitNetworkConfig>
  const proxyUrl = parseProxyUrl(p.proxyUrl)
  const timeoutSec = p.timeoutSec === null || p.timeoutSec === undefined ? GIT_TIMEOUT_SEC_DEFAULT : p.timeoutSec
  if (
    typeof timeoutSec !== 'number' || !Number.isInteger(timeoutSec)
    || timeoutSec < GIT_TIMEOUT_SEC_MIN || timeoutSec > GIT_TIMEOUT_SEC_MAX
  ) {
    throw new Error(`超时必须是 ${GIT_TIMEOUT_SEC_MIN}~${GIT_TIMEOUT_SEC_MAX} 之间的整数秒`)
  }
  return { proxyUrl, timeoutSec }
}

/** 本机回环地址（含 IPv6 方括号写法） */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

/** 代理 agent 缓存（单条：同一代理地址复用连接池，换地址即换实例） */
let cachedProxyUrl: string | null = null
let cachedAgent: HttpsProxyAgent<string> | null = null

/**
 * 目标 URL 该用哪个 agent：无代理 / 目标是回环 / URL 解析失败 → `undefined`（直连）。
 * `HttpsProxyAgent` 只在 CONNECT 隧道上按 **目标 host** 升级 TLS（dist/index.js:107-118），
 * 所以一个实例可服务任意目标 host。
 */
export function proxyAgentFor(url: string, proxyUrl: string | null): HttpsProxyAgent<string> | undefined {
  if (!proxyUrl) return undefined
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return undefined
  }
  if (isLoopbackHost(host)) return undefined
  if (cachedAgent && cachedProxyUrl === proxyUrl) return cachedAgent
  // 不 destroy 旧实例：可能有在途请求（设置改动与同步并发时让它自然结束）
  cachedAgent = new HttpsProxyAgent(proxyUrl)
  cachedProxyUrl = proxyUrl
  return cachedAgent
}

/** 单测用：清空 agent 缓存 */
export function resetProxyAgentCache(): void {
  cachedAgent = null
  cachedProxyUrl = null
}

/**
 * 包一层 isomorphic-git 的 Node http 客户端，按目标 URL 注入代理 agent。
 * `resolveNetwork` **每次请求求值**——同步设置改完立即生效，无需重建 GitSync。
 */
export function createGitHttp(resolveNetwork: () => GitNetworkConfig | null): HttpClient {
  return {
    request: (req: GitHttpRequest): Promise<GitHttpResponse> => {
      let proxyUrl: string | null = null
      try {
        proxyUrl = resolveNetwork()?.proxyUrl ?? null
      } catch {
        proxyUrl = null // 配置读取异常退化为直连，绝不因读配置失败而断掉同步
      }
      return nodeHttp.request({ ...req, agent: proxyAgentFor(req.url, proxyUrl) })
    }
  }
}
