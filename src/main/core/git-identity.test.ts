import { afterEach, describe, expect, it } from 'vitest'
import {
  IdentityHttpError,
  IdentityTimeoutError,
  fetchGitHubUser,
  isAllowedApiBaseUrl,
  detectTimeoutMs,
  normalizeStoredIdentity,
  noreplyEmail,
  parseGitHubUser,
  resolveGitIdentity,
  sanitizeIdentityPart,
  validateManualIdentity,
  describeIdentityError
} from './git-identity'
import { resetProxyAgentCache } from './git-network'
import { FAKE_GITHUB_USER, startFakeGitHub, type FakeGitHub } from '../utils/test-servers/fake-github-server'
import { startFakeProxy, type FakeProxy } from '../utils/test-servers/fake-proxy-server'

/** 裸控制字符一律用 fromCharCode 造，避免测试源码里混入不可见字节 */
const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NUL = String.fromCharCode(0)

let fakeApi: FakeGitHub | null = null
let fakeProxy: FakeProxy | null = null
afterEach(async () => {
  if (fakeApi) await fakeApi.close()
  if (fakeProxy) await fakeProxy.close()
  fakeApi = null
  fakeProxy = null
  resetProxyAgentCache()
})

const NO_PROXY = { proxyUrl: null, timeoutSec: 30 }

describe('sanitizeIdentityPart（自动识别来的自由文本只能剥不能拒）', () => {
  it('剥掉会注入 commit 头行的字符并压掉多余空白', () => {
    expect(sanitizeIdentityPart(`Koko${NL}committer Evil <x> 1 +0000`, 64)).toBe('Koko committer Evil x 1 +0000')
    expect(sanitizeIdentityPart(`  Zhang${CR}${NL}  San  `, 64)).toBe('Zhang San')
    expect(sanitizeIdentityPart(`<b>Koko</b>`, 64)).toBe('b Koko /b')
    expect(sanitizeIdentityPart(`Ko${NUL}ko`, 64)).toBe('Ko ko')
  })

  it('按码位截断（不劈开代理对），并再 trim 一次', () => {
    expect(sanitizeIdentityPart('abcdef', 3)).toBe('abc')
    expect(Array.from(sanitizeIdentityPart('😀😀😀😀', 2))).toEqual(['😀', '😀'])
    expect(sanitizeIdentityPart('ab cd', 3)).toBe('ab')
  })

  it('全是禁用字符 → 空串（调用方据此退用 login）', () => {
    expect(sanitizeIdentityPart(`<>${NL}`, 64)).toBe('')
  })
})

describe('validateManualIdentity（手填值一律拒绝而不是静默改）', () => {
  it('两个都留空 → null（= 未配置，回落自动识别）', () => {
    expect(validateManualIdentity({})).toBeNull()
    expect(validateManualIdentity({ name: null, email: null })).toBeNull()
    expect(validateManualIdentity({ name: '   ', email: '' })).toBeNull()
    expect(validateManualIdentity(undefined)).toBeNull()
  })

  it('只填一个 → 报「要一起填」', () => {
    expect(() => validateManualIdentity({ name: 'Zhang San', email: '' })).toThrow('一起填')
    expect(() => validateManualIdentity({ name: '', email: 'a@b.c' })).toThrow('一起填')
  })

  it('换行 / 尖括号 → 拒绝（否则会往 commit 对象里注入头行）', () => {
    expect(() => validateManualIdentity({ name: `Zhang${NL}San`, email: 'a@b.c' })).toThrow('不能包含换行')
    expect(() => validateManualIdentity({ name: 'Zhang <San>', email: 'a@b.c' })).toThrow('不能包含换行')
    expect(() => validateManualIdentity({ name: 'Zhang San', email: `a@b.c${NL}tree deadbeef` })).toThrow('不能包含换行')
  })

  it('超长 / 邮箱格式不对 → 拒绝', () => {
    expect(() => validateManualIdentity({ name: 'x'.repeat(65), email: 'a@b.c' })).toThrow('姓名不能超过 64')
    expect(() => validateManualIdentity({ name: 'Zhang San', email: 'not-an-email' })).toThrow('邮箱格式不对')
  })

  it('合法 → 去掉首尾空白后原样返回（不改用户输入的内容）', () => {
    expect(validateManualIdentity({ name: '  Zhang San ', email: ' zhang@users.noreply.github.com ' }))
      .toEqual({ name: 'Zhang San', email: 'zhang@users.noreply.github.com' })
    // 内部空格不压缩：手填值保持用户所写
    expect(validateManualIdentity({ name: 'Zhang  San', email: 'a@b.c' })?.name).toBe('Zhang  San')
  })
})

describe('parseGitHubUser / noreplyEmail', () => {
  it('合法响应 → 取 login/id/name；name 允许为 null', () => {
    expect(parseGitHubUser(FAKE_GITHUB_USER)).toEqual({ login: 'koko', id: 42, name: 'Koko Zhang' })
    expect(parseGitHubUser({ login: 'koko', id: 42, name: null })).toEqual({ login: 'koko', id: 42, name: null })
    expect(parseGitHubUser({ login: 'koko', id: 42 })).toEqual({ login: 'koko', id: 42, name: null })
  })

  it('形状不对 → null（不抛）', () => {
    expect(parseGitHubUser(null)).toBeNull()
    expect(parseGitHubUser('nope')).toBeNull()
    expect(parseGitHubUser({ id: 42 })).toBeNull()
    expect(parseGitHubUser({ login: '', id: 42 })).toBeNull()
    // login 会被拼进 noreply 邮箱，必须严（空格/下划线/中文都不是合法 GitHub 用户名）
    expect(parseGitHubUser({ login: 'ko ko', id: 42 })).toBeNull()
    expect(parseGitHubUser({ login: 'ko_ko', id: 42 })).toBeNull()
    expect(parseGitHubUser({ login: 'koko', id: 0 })).toBeNull()
    expect(parseGitHubUser({ login: 'koko', id: -1 })).toBeNull()
    expect(parseGitHubUser({ login: 'koko', id: 1.5 })).toBeNull()
    expect(parseGitHubUser({ login: 'koko', id: '42' })).toBeNull()
  })

  it('noreply 邮箱用 ID 形式（对 2017-07-18 前后注册的账号都成立）', () => {
    expect(noreplyEmail(42, 'koko')).toBe('42+koko@users.noreply.github.com')
  })
})

describe('resolveGitIdentity（手填 > 识别 > 兜底）', () => {
  const manual = { name: 'Zhang San', email: 'zhang@example.com' }
  const detected = { login: 'koko', id: 42, name: 'Koko Zhang', at: '2026-09-18T00:00:00.000Z' }

  it('手填优先于识别结果', () => {
    expect(resolveGitIdentity(manual, detected)).toEqual({ ...manual, source: 'manual' })
  })

  it('未手填 → 用识别的 GitHub 身份（noreply 邮箱）', () => {
    expect(resolveGitIdentity(null, detected)).toEqual({
      name: 'Koko Zhang',
      email: '42+koko@users.noreply.github.com',
      source: 'pat'
    })
  })

  it('识别到的昵称为 null 或被净化成空 → 退用 login', () => {
    expect(resolveGitIdentity(null, { ...detected, name: null }).name).toBe('koko')
    expect(resolveGitIdentity(null, { ...detected, name: '<script>' }).name).toBe('script')
    expect(resolveGitIdentity(null, { ...detected, name: `<>${NL}` }).name).toBe('koko')
  })

  it('都没有 → 内置兜底（与 M12 之前的行为一致）', () => {
    expect(resolveGitIdentity(null, null)).toEqual({ name: 'BeanWise', email: 'beanwise@local', source: 'default' })
  })
})

describe('normalizeStoredIdentity（配置读坏也绝不返回半成品）', () => {
  it('垃圾输入 → 空默认', () => {
    expect(normalizeStoredIdentity(null)).toEqual({ manual: null, detected: {} })
    expect(normalizeStoredIdentity('nope')).toEqual({ manual: null, detected: {} })
    expect(normalizeStoredIdentity(42)).toEqual({ manual: null, detected: {} })
  })

  it('半填的手填值整体作废（否则会拼出「姓名手填 + 邮箱识别」的缝合身份）', () => {
    expect(normalizeStoredIdentity({ manual: { name: 'Zhang San' } }).manual).toBeNull()
    expect(normalizeStoredIdentity({ manual: { name: 'Zhang San', email: '' } }).manual).toBeNull()
    expect(normalizeStoredIdentity({ manual: { name: 'Zhang San', email: 'a@b.c' } }).manual)
      .toEqual({ name: 'Zhang San', email: 'a@b.c' })
  })

  it('识别缓存逐条校验：非法项丢弃，合法项留下', () => {
    const ok = { login: 'koko', id: 42, name: 'Koko', at: '2026-09-18T00:00:00.000Z' }
    const result = normalizeStoredIdentity({
      detected: {
        'f:\\ledger-a': ok,
        'f:\\ledger-b': { login: 'bad login', id: 1, name: null, at: '' },
        'f:\\ledger-c': { login: 'koko', id: 0, name: null, at: '' },
        'f:\\ledger-d': 'nope'
      }
    })
    expect(result.detected).toEqual({ 'f:\\ledger-a': ok })
  })
})

describe('detectTimeoutMs / isAllowedApiBaseUrl', () => {
  it('超时跟随同步配置但有 15s 上限', () => {
    expect(detectTimeoutMs({ proxyUrl: null, timeoutSec: 3 })).toBe(3000)
    expect(detectTimeoutMs({ proxyUrl: null, timeoutSec: 600 })).toBe(15_000)
    // 非法/缺省值回落 30s，再被上限截到 15s（同步超时调到 600s 也不该让识别挂在那儿）
    expect(detectTimeoutMs({ proxyUrl: null, timeoutSec: 0 })).toBe(15_000)
  })

  it('API 根白名单：只放行官方域名与明文回环（防渲染端把 PAT 指到任意地址）', () => {
    expect(isAllowedApiBaseUrl('https://api.github.com')).toBe(true)
    expect(isAllowedApiBaseUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isAllowedApiBaseUrl('http://localhost:8080')).toBe(true)
    expect(isAllowedApiBaseUrl('https://evil.example.com')).toBe(false)
    expect(isAllowedApiBaseUrl('http://192.168.1.9:8080')).toBe(false)
    expect(isAllowedApiBaseUrl('not a url')).toBe(false)
  })
})

describe('fetchGitHubUser（真实 HTTP，零外网）', () => {
  it('200 → 解析出身份；且凭据与必需请求头都发出去了', async () => {
    fakeApi = await startFakeGitHub()
    const user = await fetchGitHubUser('ghp_test', { network: NO_PROXY, baseUrl: fakeApi.url })
    expect(user).toEqual(FAKE_GITHUB_USER)
    expect(fakeApi.requests).toHaveLength(1)
    const req = fakeApi.requests[0]!
    expect(req.url).toBe('/user')
    expect(req.method).toBe('GET')
    expect(req.authorization).toBe('Bearer ghp_test')
    // GitHub API 强制要求 User-Agent，缺了直接 403（会被误诊成 PAT 无效）
    expect(req.userAgent).toBe('BeanWise')
    expect(req.accept).toBe('application/vnd.github+json')
  })

  it('401 → 带状态码的 IdentityHttpError（由 describeIdentityError 转人话）', async () => {
    fakeApi = await startFakeGitHub({ status: 401, body: '{"message":"Bad credentials"}' })
    const err = await fetchGitHubUser('ghp_bad', { network: NO_PROXY, baseUrl: fakeApi.url }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IdentityHttpError)
    expect((err as IdentityHttpError).status).toBe(401)
    expect(describeIdentityError(err, NO_PROXY)).toContain('认证失败')
  })

  it('非 JSON 响应（代理错误页）不当成功处理', async () => {
    fakeApi = await startFakeGitHub({ status: 200, body: '<html>proxy says no</html>' })
    await expect(fetchGitHubUser('ghp_test', { network: NO_PROXY, baseUrl: fakeApi.url }))
      .rejects.toThrow('不是合法 JSON')
  })

  it('非白名单 API 根 → 直接拒绝（PAT 不外发）', async () => {
    await expect(fetchGitHubUser('ghp_test', { network: NO_PROXY, baseUrl: 'https://evil.example.com' }))
      .rejects.toThrow('不允许的 GitHub API 地址')
  })

  it('代理接受 CONNECT 但不回包 → 到点有界返回（兜底定时器生效；signal 此时不生效）', async () => {
    fakeProxy = await startFakeProxy({ hang: true })
    const started = Date.now()
    const err = await fetchGitHubUser('ghp_test', {
      network: { proxyUrl: fakeProxy.url, timeoutSec: 1 },
      timeoutMs: 300
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IdentityTimeoutError)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(describeIdentityError(err, { proxyUrl: fakeProxy.url, timeoutSec: 1 })).toContain('识别超时')
  }, 10_000)

  it('识别请求**真的走代理**：CONNECT 目标为 api.github.com:443，凭据不过代理明文', async () => {
    fakeProxy = await startFakeProxy() // 默认对 CONNECT 回 502
    const err = await fetchGitHubUser('ghp_secret', {
      network: { proxyUrl: fakeProxy.url, timeoutSec: 30 }
    }).catch((e: unknown) => e)
    expect(fakeProxy.connects).toEqual(['api.github.com:443'])
    // 502 是 https-proxy-agent 把代理响应回放后的**正常响应**（不是异常），必须归到「代理未放行」
    expect(err).toBeInstanceOf(IdentityHttpError)
    expect((err as IdentityHttpError).status).toBe(502)
    expect(describeIdentityError(err, { proxyUrl: fakeProxy.url, timeoutSec: 30 }))
      .toContain(`代理 ${fakeProxy.url} 返回 502`)
  })
})

describe('describeIdentityError（把「代理没开」「代理未放行」「PAT 不对」分开说）', () => {
  const proxied = { proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 30 }

  it('403 / 404 / 5xx 各自给话术', () => {
    expect(describeIdentityError(new IdentityHttpError(403, ''), NO_PROXY)).toContain('权限不足')
    expect(describeIdentityError(new IdentityHttpError(404, ''), NO_PROXY)).toContain('404')
    expect(describeIdentityError(new IdentityHttpError(503, ''), proxied)).toContain('未放行 api.github.com')
    expect(describeIdentityError(new IdentityHttpError(503, ''), NO_PROXY)).toContain('请稍后重试')
  })

  it('连接被拒：有代理说代理，没代理说网络', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(describeIdentityError(refused, proxied)).toContain('无法连接代理 http://127.0.0.1:7890')
    expect(describeIdentityError(refused, NO_PROXY)).toContain('无法连接 GitHub')
  })

  it('代理回放被解析器拒（HPE_*）也算代理未放行', () => {
    const hpe = Object.assign(new Error('Parse Error'), { code: 'HPE_INVALID_CONSTANT' })
    expect(describeIdentityError(hpe, proxied)).toContain('未放行 api.github.com')
  })
})
