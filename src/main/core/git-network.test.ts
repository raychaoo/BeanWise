import { afterEach, describe, expect, it } from 'vitest'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { createGitHttp, defaultGitNetwork, isLoopbackHost, normalizeGitNetwork, parseProxyUrl, proxyAgentFor, resetProxyAgentCache } from './git-network'
import { startFakeProxy, type FakeProxy } from '../utils/test-servers/fake-proxy-server'

let proxy: FakeProxy | null = null
afterEach(async () => {
  if (proxy) await proxy.close()
  proxy = null
  resetProxyAgentCache()
})

describe('parseProxyUrl', () => {
  it('空值 → null（直连），不是错误', () => {
    expect(parseProxyUrl(null)).toBeNull()
    expect(parseProxyUrl(undefined)).toBeNull()
    expect(parseProxyUrl('')).toBeNull()
    expect(parseProxyUrl('   ')).toBeNull()
  })

  it('合法 http/https 代理 → 按 origin 规范化（丢 path/query/尾斜杠）', () => {
    expect(parseProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(parseProxyUrl('http://127.0.0.1:7890/')).toBe('http://127.0.0.1:7890')
    expect(parseProxyUrl('  http://127.0.0.1:7890  ')).toBe('http://127.0.0.1:7890')
    expect(parseProxyUrl('http://127.0.0.1:7890/pac?x=1')).toBe('http://127.0.0.1:7890')
    expect(parseProxyUrl('https://proxy.example:8080')).toBe('https://proxy.example:8080')
  })

  it('非法一律抛中文错误', () => {
    expect(() => parseProxyUrl('socks5://127.0.0.1:1080')).toThrow('仅支持 HTTP/HTTPS 代理地址')
    expect(() => parseProxyUrl('ftp://127.0.0.1:21')).toThrow('仅支持 HTTP/HTTPS 代理地址')
    expect(() => parseProxyUrl('127.0.0.1:7890')).toThrow('代理地址无法解析')
    expect(() => parseProxyUrl('http://127.0.0.1')).toThrow('代理地址需带端口')
    expect(() => parseProxyUrl('http://127.0.0.1:0')).toThrow('代理地址需带端口')
    // 代理凭据不进明文配置（密钥只进 safeStorage）——直接拒绝而不是悄悄丢掉
    expect(() => parseProxyUrl('http://user:pw@127.0.0.1:7890')).toThrow('代理地址不要携带用户名密码')
    expect(() => parseProxyUrl(`http://127.0.0.1:7890/?${'x'.repeat(200)}`)).toThrow('不能超过')
    expect(() => parseProxyUrl(123 as unknown as string)).toThrow('代理地址必须是字符串')
  })
})

describe('normalizeGitNetwork', () => {
  it('缺省 → 直连 + 30s；代理可空、超时可配', () => {
    expect(normalizeGitNetwork(null)).toEqual({ proxyUrl: null, timeoutSec: 30 })
    expect(normalizeGitNetwork({ proxyUrl: null })).toEqual({ proxyUrl: null, timeoutSec: 30 })
    expect(normalizeGitNetwork({ proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 120 }))
      .toEqual({ proxyUrl: 'http://127.0.0.1:7890', timeoutSec: 120 })
    expect(defaultGitNetwork()).toEqual({ proxyUrl: null, timeoutSec: 30 })
  })

  it('超时必须是 1~600 的整数秒', () => {
    expect(() => normalizeGitNetwork({ timeoutSec: 0 })).toThrow('超时必须是')
    expect(() => normalizeGitNetwork({ timeoutSec: 601 })).toThrow('超时必须是')
    expect(() => normalizeGitNetwork({ timeoutSec: 1.5 })).toThrow('超时必须是')
    expect(() => normalizeGitNetwork({ timeoutSec: '30' })).toThrow('超时必须是')
    expect(normalizeGitNetwork({ timeoutSec: 1 }).timeoutSec).toBe(1)
    expect(normalizeGitNetwork({ timeoutSec: 600 }).timeoutSec).toBe(600)
  })
})

describe('isLoopbackHost', () => {
  it('认定 127.0.0.1 / localhost / ::1（含大小写与 IPv6 方括号）', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LocalHost', '[::1]', '::1', '  127.0.0.1  ']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['github.com', '127.0.0.1.evil.com', '10.0.0.1', 'example.invalid']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('proxyAgentFor', () => {
  it('无代理 / 目标回环 → undefined（直连）', () => {
    expect(proxyAgentFor('https://github.com/a/b.git', null)).toBeUndefined()
    expect(proxyAgentFor('http://127.0.0.1:8080/x', 'http://127.0.0.1:7890')).toBeUndefined()
    expect(proxyAgentFor('http://localhost:8080/x', 'http://127.0.0.1:7890')).toBeUndefined()
  })

  it('非回环目标 → HttpsProxyAgent；同一代理地址复用同一实例', () => {
    const a = proxyAgentFor('https://github.com/a/b.git', 'http://127.0.0.1:7890')
    const b = proxyAgentFor('https://github.com/c/d.git', 'http://127.0.0.1:7890')
    expect(a).toBeInstanceOf(HttpsProxyAgent)
    expect(b).toBe(a) // 连接池复用
    const other = proxyAgentFor('https://github.com/a/b.git', 'http://127.0.0.1:7891')
    expect(other).not.toBe(a) // 换地址即换实例
  })
})

describe('createGitHttp', () => {
  it('把请求真的送进代理：假代理收到目标的 CONNECT', async () => {
    proxy = await startFakeProxy()
    const http = createGitHttp(() => ({ proxyUrl: proxy!.url, timeoutSec: 30 }))
    // 目标是不存在的域名：只有「走代理」才会产生 CONNECT example.invalid:443（零外网依赖）
    const res = await http.request({ url: 'https://example.invalid/x', method: 'GET' })
    expect(res.statusCode).toBe(502) // 假代理固定回 502，说明隧道确实建到了它
    expect(proxy.connects).toEqual(['example.invalid:443'])
  })

  it('目标回环 → 即便配了代理也直连；读配置抛错也只退化为直连', async () => {
    proxy = await startFakeProxy()
    // 直接请求假代理自身的地址（它是个真实监听的回环 HTTP 服务）：普通请求直达 = 没走代理
    const viaProxyCfg = createGitHttp(() => ({ proxyUrl: proxy!.url, timeoutSec: 30 }))
    expect((await viaProxyCfg.request({ url: `${proxy!.url}/x`, method: 'GET' })).statusCode).toBe(502)
    expect(proxy.connects).toEqual([]) // 没有 CONNECT ⇒ 回环绕过生效

    const throwing = createGitHttp(() => { throw new Error('配置读不到') })
    expect((await throwing.request({ url: `${proxy!.url}/x`, method: 'GET' })).statusCode).toBe(502)
  })
})
