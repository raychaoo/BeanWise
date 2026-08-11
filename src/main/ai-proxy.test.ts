/**
 * M7-T2：DeepSeekProxy 测试（fetchImpl 注入，零网络）。
 * 覆盖：成功 tool call、JSON number 容错、schema 校验拒绝（绿灯核心）、
 * HTTP 401/402/429/5xx、超时/网络错误、无 tool_calls、arguments 非 JSON、请求体断言。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AiParseResult } from '../shared/ipc'
import { buildSystemPrompt, DeepSeekProxy, mapHttpStatus } from './ai-proxy'

const validArgs = JSON.stringify({
  entries: [{
    date: '2026-08-11',
    flag: '*',
    payee: '测试',
    narration: '午饭',
    postings: [
      { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
      { account: 'Assets:Bank:CNB', number: '-25.50', currency: 'CNY' }
    ]
  }]
})

function chatCompletion(argumentsJson: string): unknown {
  return {
    id: 't-1', object: 'chat.completion', created: 0, model: 'deepseek-v4-flash',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add_entries', arguments: argumentsJson } }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

function proxyWith(fetchImpl: unknown): DeepSeekProxy {
  return new DeepSeekProxy({
    baseUrl: 'http://mock.local',
    fetchImpl: fetchImpl as typeof fetch,
    timeoutMs: 1000,
    now: () => '2026-08-11'
  })
}

describe('DeepSeekProxy.parse', () => {
  it('成功：合法 tool call → ok:true + drafts（金额保持字符串）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => chatCompletion(validArgs) })
    const r: AiParseResult = await proxyWith(fetchImpl).parse('sk-test', '昨天午饭 25.5', ['Expenses:Food'])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.drafts).toHaveLength(1)
      expect(r.drafts![0].postings[0].number).toBe('25.50')
      expect(r.drafts![0].date).toBe('2026-08-11')
    }
  })

  it('JSON number 金额容错 → 草稿金额为字符串', async () => {
    const args = JSON.stringify({
      entries: [{
        date: '2026-08-11',
        postings: [
          { account: 'Expenses:Food', number: 12.5, currency: 'CNY' },
          { account: 'Assets:Bank:CNB', number: -12.5, currency: 'CNY' }
        ]
      }]
    })
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => chatCompletion(args) })
    const r = await proxyWith(fetchImpl).parse('sk-test', 'x', [])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.drafts![0].postings[0].number).toBe('12.5')
      expect(r.drafts![0].postings[1].number).toBe('-12.5')
    }
  })

  it('schema 校验拒绝非法输出（绿灯核心）', async () => {
    const badArgs = JSON.stringify({
      entries: [{
        date: '2026-13-40',
        postings: [
          { account: 'Expenses:Food', number: 'abc', currency: 'CNY' },
          { account: 'Assets:Bank:CNB', number: '-25.50', currency: 'CNY' }
        ]
      }]
    })
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => chatCompletion(badArgs) })
    const r = await proxyWith(fetchImpl).parse('sk-test', 'x', [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('AI 输出不符合录入格式')
  })

  it('无 tool_calls → 拒绝', async () => {
    const resp = { id: 't-1', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => resp })
    const r = await proxyWith(fetchImpl).parse('sk-test', 'x', [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未返回结构化指令')
  })

  it('arguments 非 JSON → 拒绝', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => chatCompletion('{not json') })
    const r = await proxyWith(fetchImpl).parse('sk-test', 'x', [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('无法解析为 JSON')
  })

  it('HTTP 401/402/429/500 分别映射中文提示', async () => {
    const cases: Array<[number, string]> = [
      [401, 'API Key 无效'], [402, '余额不足'], [429, '繁忙'], [500, '繁忙'], [503, '繁忙']
    ]
    for (const [status, expectText] of cases) {
      const fetchImpl = vi.fn().mockResolvedValue({ status, json: async () => ({}) })
      const r = await proxyWith(fetchImpl).parse('sk-test', 'x', [])
      expect(r.ok).toBe(false)
      expect(r.error).toContain(expectText)
    }
  })

  it('超时（AbortError）→ 超时提示', async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    const fetchImpl = vi.fn().mockRejectedValue(err)
    const r = await proxyWith(fetchImpl).parse('sk-test', 'x', [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('超时')
  })

  it('网络错误（TypeError）→ 网络提示', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const r = await proxyWith(fetchImpl).parse('sk-test', 'x', [])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('网络错误')
  })

  it('请求体：tool_choice 强制 + 系统提示含日期/账户 + Authorization 头', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => chatCompletion(validArgs) })
    await proxyWith(fetchImpl).parse('sk-1', 'hi', ['Assets:Bank:CNB', 'Expenses:Food'])
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }]
    expect(url).toBe('http://mock.local/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-1')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'add_entries' } })
    expect(body.messages[0].content).toContain('2026-08-11')
    expect(body.messages[0].content).toContain('Assets:Bank:CNB')
    expect(body.messages[1].content).toBe('hi')
  })
})

describe('mapHttpStatus / buildSystemPrompt', () => {
  it('mapHttpStatus：401/402/429/5xx 中文提示，其余 null', () => {
    expect(mapHttpStatus(401)).toContain('API Key 无效')
    expect(mapHttpStatus(402)).toContain('余额不足')
    expect(mapHttpStatus(429)).not.toBeNull()
    expect(mapHttpStatus(502)).not.toBeNull()
    expect(mapHttpStatus(200)).toBeNull()
    expect(mapHttpStatus(404)).toBeNull()
  })

  it('buildSystemPrompt：无账户时提示可自由创建', () => {
    expect(buildSystemPrompt('2026-08-11', [])).toContain('2026-08-11')
    expect(buildSystemPrompt('2026-08-11', [])).toContain('自由创建')
    expect(buildSystemPrompt('2026-08-11', ['Expenses:Food'])).toContain('Expenses:Food')
  })
})
