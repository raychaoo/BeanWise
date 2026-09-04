/**
 * M7 测试基础设施：进程内 DeepSeek chat/completions mock（零网络/零密钥）。
 * 默认返回合法 add_entries tool call；setResponder 可注入非法输出 / 错误状态。
 * 与 git-test-server 同策略：独立非 test 模块，单测/E2E 共用单一实现。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export type AiResponder = (body: unknown) => { status: number; json: unknown }

const DEFAULT_TOOL_ARGS = JSON.stringify({
  entries: [{
    date: '2026-08-11',
    flag: '*',
    payee: 'AI 录入',
    narration: 'E2E 生成的交易',
    postings: [
      { account: 'Expenses:Food', number: '25.50', currency: 'CNY' },
      { account: 'Assets:Bank:CNB', number: '-25.50', currency: 'CNY' }
    ]
  }]
})

/** 构造 chat.completion 响应（tool_calls 载荷） */
export function chatCompletion(argumentsJson: string): unknown {
  return {
    id: 'e2e-1',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-v4-flash',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add_entries', arguments: argumentsJson } }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

export interface AiServer {
  url: string
  setResponder(responder: AiResponder): void
  close(): Promise<void>
}

export async function startAiServer(): Promise<AiServer> {
  let responder: AiResponder = () => ({ status: 200, json: chatCompletion(DEFAULT_TOOL_ARGS) })
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = body ? (JSON.parse(body) as unknown) : {}
      const r = responder(parsed)
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    setResponder: (r) => { responder = r },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}
