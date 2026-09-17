/**
 * M13：提交人身份的解析（纯逻辑）与 GitHub 自动识别（一次 HTTP 请求）。
 *
 * 优先级（用户定稿「二和三都要，没配置时用二，配置了用三」）：
 *   手填（manual） > PAT 自动识别（pat） > 内置兜底 `BeanWise <beanwise@local>`（default）。
 *
 * **提交路径绝不联网**：`resolveGitIdentity` 是纯函数，只吃已缓存的手填值与识别结果——
 * 识别只发生在两个显式时机（`sync:configure` 成功后 best-effort、用户点「识别 GitHub 身份」）。
 * 否则离线时保存账本会被网络卡住。
 *
 * 为什么用 noreply 邮箱而不是 `GET /user` 的 `email` 字段：后者在用户开启「保持邮箱私密」
 * 时为 `null`，且可能是一个**未在该账号验证过**的地址——GitHub 按邮箱归属账号，用错地址会把
 * 提交算到别人名下。`<id>+<login>@users.noreply.github.com` 是 GitHub 自家 UI 生成提交用的形式，
 * 且 `id`/`login` 在响应里必定存在（ID 形式对 2017-07-18 前后注册的账号都成立，见 ADR 30）。
 *
 * 头注入防护：isomorphic-git 的 `formatAuthor` 是 `` `${name} <${email}>` ``、**零转义**
 * （index.cjs:4167-4170），而 GitHub 昵称可由用户随意改。故手填值**拒绝**换行/尖括号/控制字符，
 * 自动识别来的值**净化**（静默剥掉，净化成空则退用 login）。
 *
 * 传输细节（均实测）：
 * - 代理：`https.request({ agent: proxyAgentFor(...) })`，Node 的 https.Agent 会置
 *   `secureEndpoint: true`，agent 据此在 CONNECT 后按目标 host 升级 TLS（SNI 正确）；
 *   PAT 只在隧道内，代理看不到。
 * - 超时用**两层**：`AbortSignal.timeout` 负责真中断已拿到 socket 的连接（实测直连悬挂场景
 *   416ms 即中断、进程无残留句柄），但**代理 CONNECT 悬挂时它不生效**（实测：请求还停在
 *   agent.connect 里，signal 到点也没让 Promise 落定）——故外面再套一层 `withDeadline` 兜底
 *   保证有界返回。已知限制（同 M12 的 withTimeout）：兜底到点时底层 CONNECT socket 仍悬挂，
 *   要等 agent/进程回收；对「代理软件没开」（ECONNREFUSED）与「代理不回包」两种常见故障，
 *   前者立刻报错、后者到点报错，用户都拿得到可读文案。
 * - 代理拒绝 CONNECT 时 `https-proxy-agent` 会把代理响应**回放**进 socket，调用方拿到的是
 *   **正常 resolve 的 502 响应**而不是异常（实测）——故必须显式判 `statusCode`，
 *   不能指望 catch 里看出「代理未放行」。
 */
import http from 'node:http'
import https from 'node:https'
import { GIT_IDENTITY_EMAIL_MAX, GIT_IDENTITY_NAME_MAX, GIT_TIMEOUT_SEC_DEFAULT } from '../../shared/ipc'
import type {
  DetectedGitIdentity,
  GitAuthor,
  GitIdentity,
  GitIdentityManual,
  GitNetworkConfig,
  SaveIdentityParams
} from '../../shared/ipc'
import { isLoopbackHost, proxyAgentFor } from './git-network'
import { GIT_AUTHOR } from './git-sync'

/** 生产环境的 GitHub API 根；E2E/单测经 `BEANWISE_GITHUB_API_BASE_URL` 注入回环假服务器 */
export const GITHUB_API_BASE_URL = 'https://api.github.com'
const USER_PATH = '/user'
/** GitHub API 强制要求 User-Agent，缺了直接 403（会被误诊成 PAT 无效） */
const USER_AGENT = 'BeanWise'
/** 响应体上限：用户信息就几百字节，防异常大响应 */
const MAX_RESPONSE_BYTES = 64 * 1024
/** 识别超时上限：同步超时调到 600s 也不该让一次身份识别挂在那儿 */
const DETECT_TIMEOUT_MAX_MS = 15_000
/** GitHub 用户名规则（会被拼进 noreply 邮箱，必须严） */
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/

/**
 * 是否含会破坏 commit 头行结构的字符：`<` `>`（撑破 `name <email>` 结构）、
 * C0 控制字符与 DEL（换行 = 注入一行头）。
 * 用码点判断而不是正则字面量——正则里嵌裸控制字符可读性差且易被工具链改坏。
 */
function hasForbiddenChars(raw: string): boolean {
  if (raw.includes('<') || raw.includes('>')) return true
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** 把上面的禁用字符换成空格（仅用于**自动识别**来的自由文本：只能剥不能拒） */
function stripForbiddenChars(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    out += ch === '<' || ch === '>' || code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out
}

/**
 * 存储形态（机器级 electron-store `git-identity` 的 `identity` 键）。
 * `detected` 按工作目录小写路径隔离——它是**该目录 PAT** 的派生物，必须与 PAT 同域，
 * 否则换账本目录会把上一个账本的 GitHub 身份带过来（新账本的首次提交就会挂错人）。
 */
export interface StoredGitIdentity {
  manual: GitIdentityManual | null
  detected: Record<string, DetectedGitIdentity>
}

export function defaultStoredIdentity(): StoredGitIdentity {
  return { manual: null, detected: {} }
}

/** 净化 + 压掉多余空白 + 按上限截断（按码位截断，避免劈开代理对） */
export function sanitizeIdentityPart(raw: string, max: number): string {
  const cleaned = stripForbiddenChars(raw).replace(/\s+/g, ' ').trim()
  return Array.from(cleaned).slice(0, max).join('').trim()
}

/**
 * 校验手填身份：两个都留空 → `null`（= 未配置，回落自动识别）；
 * 只填一个 / 含非法字符 / 超长 / 邮箱格式不对 → 抛中文错误（渲染端回显）。
 */
export function validateManualIdentity(raw: unknown): GitIdentityManual | null {
  const p = (raw ?? {}) as Partial<SaveIdentityParams>
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  const email = typeof p.email === 'string' ? p.email.trim() : ''
  if (name === '' && email === '') return null
  if (name === '' || email === '') {
    throw new Error('姓名与邮箱要一起填，或都留空（留空则用 GitHub 自动识别）')
  }
  if (hasForbiddenChars(name) || hasForbiddenChars(email)) {
    throw new Error('姓名/邮箱不能包含换行或 < > 字符')
  }
  if (Array.from(name).length > GIT_IDENTITY_NAME_MAX) {
    throw new Error(`姓名不能超过 ${GIT_IDENTITY_NAME_MAX} 个字符`)
  }
  if (Array.from(email).length > GIT_IDENTITY_EMAIL_MAX) {
    throw new Error(`邮箱不能超过 ${GIT_IDENTITY_EMAIL_MAX} 个字符`)
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('邮箱格式不对，应形如 you@example.com（GitHub 归属需已在该账号验证的地址）')
  }
  return { name, email }
}

/** GitHub 的 noreply 邮箱（ID 形式对 2017-07-18 前后注册的账号都成立，见 ADR 30） */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`
}

/** `GET /user` 响应 → 识别结果；形状不对返回 `null`（不抛） */
export function parseGitHubUser(json: unknown): { login: string; id: number; name: string | null } | null {
  if (typeof json !== 'object' || json === null) return null
  const raw = json as { login?: unknown; id?: unknown; name?: unknown }
  if (typeof raw.login !== 'string' || !LOGIN_RE.test(raw.login)) return null
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id <= 0) return null
  const name = typeof raw.name === 'string' ? raw.name : null
  return { login: raw.login, id: raw.id, name }
}

/** 推导生效身份（纯函数，**提交路径每次调用它求值**，不联网） */
export function resolveGitIdentity(
  manual: GitIdentityManual | null,
  detected: DetectedGitIdentity | null
): GitIdentity {
  if (manual) return { name: manual.name, email: manual.email, source: 'manual' }
  if (detected) {
    const fallback = sanitizeIdentityPart(detected.login, GIT_IDENTITY_NAME_MAX)
    return {
      // 昵称可能为 null，或被净化成空（例如昵称是 `<b>`）→ 退用 login
      name: sanitizeIdentityPart(detected.name ?? '', GIT_IDENTITY_NAME_MAX) || fallback,
      email: noreplyEmail(detected.id, detected.login),
      source: 'pat'
    }
  }
  return { ...(GIT_AUTHOR as GitAuthor), source: 'default' }
}

/** 单条识别结果校验（脏数据丢弃，绝不因配置损坏断掉同步） */
function normalizeDetected(raw: unknown): DetectedGitIdentity | null {
  if (typeof raw !== 'object' || raw === null) return null
  const d = raw as Partial<DetectedGitIdentity>
  if (typeof d.login !== 'string' || !LOGIN_RE.test(d.login)) return null
  if (typeof d.id !== 'number' || !Number.isInteger(d.id) || d.id <= 0) return null
  const name = typeof d.name === 'string' ? d.name : null
  const at = typeof d.at === 'string' ? d.at : ''
  return { login: d.login, id: d.id, name, at }
}

/** 读脏数据一律兜默认/丢弃非法项，不抛 */
export function normalizeStoredIdentity(raw: unknown): StoredGitIdentity {
  if (typeof raw !== 'object' || raw === null) return defaultStoredIdentity()
  const r = raw as { manual?: unknown; detected?: unknown }
  let manual: GitIdentityManual | null = null
  try {
    // 半填的手填值整体作废（否则会拼出「name 取手填、email 取识别」的缝合身份）
    manual = validateManualIdentity(r.manual)
  } catch {
    manual = null
  }
  const detected: Record<string, DetectedGitIdentity> = {}
  if (typeof r.detected === 'object' && r.detected !== null) {
    for (const [key, value] of Object.entries(r.detected as Record<string, unknown>)) {
      const item = normalizeDetected(value)
      if (item) detected[key] = item
    }
  }
  return { manual, detected }
}

/** 识别请求超时（ms）：跟随同步超时，但有上限（见 DETECT_TIMEOUT_MAX_MS） */
export function detectTimeoutMs(network: GitNetworkConfig): number {
  const sec = Number.isFinite(network.timeoutSec) && network.timeoutSec > 0 ? network.timeoutSec : GIT_TIMEOUT_SEC_DEFAULT
  return Math.min(sec * 1000, DETECT_TIMEOUT_MAX_MS)
}

/**
 * API 根白名单：官方域名，或**明文回环**（E2E/单测的进程内假服务器）。
 * 这道闸门保证 baseUrl 不由渲染端控制——否则等于给渲染端一个「把 PAT 发到任意地址」的原语。
 */
export function isAllowedApiBaseUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:' && url.hostname === 'api.github.com') return true
  return url.protocol === 'http:' && isLoopbackHost(url.hostname)
}

/** 带 HTTP 状态码的错误（`describeIdentityError` 据此分流） */
export class IdentityHttpError extends Error {
  readonly status: number
  constructor(status: number, body: string) {
    super(`GitHub 返回 ${status}${body ? `：${sanitizeIdentityPart(body, 120)}` : ''}`)
    this.name = 'IdentityHttpError'
    this.status = status
  }
}

/** 兜底超时（见模块头「超时用两层」：代理 CONNECT 悬挂时 signal 不生效，靠这个保证有界返回） */
export class IdentityTimeoutError extends Error {
  constructor(ms: number) {
    super(`识别超时（${ms}ms）`)
    this.name = 'IdentityTimeoutError'
  }
}

/** 给 promise 加兜底截止时间（清掉定时器，不留悬挂句柄） */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new IdentityTimeoutError(ms)), ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 单次 GET：按协议分派 + 代理 agent + 真中断超时；不跟随重定向（带凭据的请求不跟随更安全） */
function getOnce(
  url: string,
  opts: { headers: Record<string, string>; agent?: http.Agent; timeoutMs: number }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const mod = isHttps ? https : http
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port === '' ? (isHttps ? 443 : 80) : Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: opts.headers,
        agent: opts.agent,
        signal: AbortSignal.timeout(opts.timeoutMs)
      },
      (res) => {
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('GitHub 响应过大'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

export interface FetchGitHubUserOptions {
  network: GitNetworkConfig
  /** API 根；缺省官方（仅测试/E2E 注入回环假服务器，见 isAllowedApiBaseUrl） */
  baseUrl?: string
  timeoutMs?: number
}

/**
 * 用 PAT 识别 GitHub 身份。走用户配置的本机代理（`proxyAgentFor`；目标为回环时自动直连）。
 * 失败一律抛（`IdentityHttpError` 带状态码 / 传输错误带 `code`），由 `describeIdentityError` 转人话。
 */
export async function fetchGitHubUser(
  token: string,
  opts: FetchGitHubUserOptions
): Promise<{ login: string; id: number; name: string | null }> {
  const baseUrl = (opts.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, '')
  if (!isAllowedApiBaseUrl(baseUrl)) throw new Error(`不允许的 GitHub API 地址：${baseUrl}`)
  const url = `${baseUrl}${USER_PATH}`
  const timeoutMs = opts.timeoutMs ?? detectTimeoutMs(opts.network)
  const res = await withDeadline(
    getOnce(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT
      },
      agent: proxyAgentFor(url, opts.network.proxyUrl),
      timeoutMs
    }),
    timeoutMs
  )
  // 代理拒绝 CONNECT 时这里是 502（https-proxy-agent 回放代理响应，实测不是异常）——必须显式判
  if (res.status < 200 || res.status >= 300) throw new IdentityHttpError(res.status, res.body)
  let json: unknown
  try {
    json = JSON.parse(res.body)
  } catch {
    throw new Error('GitHub 返回的不是合法 JSON')
  }
  const user = parseGitHubUser(json)
  if (!user) throw new Error('GitHub 返回的用户信息不完整')
  return user
}

/** 识别失败的诊断文案（把「代理没开」「代理未放行」「PAT 不对」「限流」分开说） */
export function describeIdentityError(err: unknown, network: GitNetworkConfig): string {
  const status = (err as { status?: unknown })?.status
  const code = (err as { code?: unknown })?.code
  const raw = String((err as { message?: unknown })?.message ?? err)
  if (err instanceof IdentityTimeoutError || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED' || /aborted|timed? ?out/i.test(raw)) {
    const sec = Math.round(detectTimeoutMs(network) / 1000)
    return `识别超时（${sec}s）：${
      network.proxyUrl ? `请确认代理 ${network.proxyUrl} 能访问 api.github.com` : '请检查网络，或在「本机网络」里配置本机代理'
    }`
  }
  if (status === 401) return '网络已通，但认证失败：PAT 无效或已被撤销，请重新配置同步'
  if (status === 403) return 'GitHub 拒绝访问：PAT 权限不足（fine-grained 令牌需 Profile 读权限），或触发了限流'
  if (status === 404) return 'GitHub API 返回 404：请检查网络与代理设置'
  if (typeof status === 'number' && status >= 500) {
    return network.proxyUrl
      ? `代理 ${network.proxyUrl} 返回 ${status}：代理未放行 api.github.com，或代理节点不可用`
      : `GitHub 返回 ${status}：请稍后重试`
  }
  if (typeof status === 'number' && status >= 400) return `GitHub 返回 ${status}：${sanitizeIdentityPart(raw, 120)}`
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return network.proxyUrl
      ? `无法连接代理 ${network.proxyUrl}（${code}）：请确认代理软件已启动、端口与地址正确`
      : `无法连接 GitHub（${code}）：请检查网络，或在「本机网络」里配置本机代理`
  }
  // 代理返回非法响应时 HTTP 解析器抛 HPE_*
  if (typeof code === 'string' && (code.startsWith('HPE_') || code === 'EPROTO')) {
    return network.proxyUrl
      ? `代理 ${network.proxyUrl} 未放行 api.github.com（${code}）`
      : `连接 GitHub 失败（${code}）`
  }
  return network.proxyUrl ? `识别失败（当前代理 ${network.proxyUrl}）：${raw}` : `识别失败：${raw}`
}
