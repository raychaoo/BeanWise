/**
 * M7：DeepSeek 代理（ADR 12/13：主进程代理 + Function Calling + 本地 schema 校验）。
 * 纯客户端：baseUrl / fetchImpl / timeoutMs / now 可注入（单测/E2E 走 mock，git-test-server 模式）；
 * apiKey 经 parse() 调用方注入——实例不持有关键字成员（无密钥残留）。
 * 错误映射见设计 spec §3.4；日志脱敏由调用方负责（本模块不打日志）。
 */
import type { AiParseResult } from '../shared/ipc'
import { addEntriesToolSchema, AI_TOOL, AI_TOOL_NAME, formatAiValidationError } from './ai-schema'

export const AI_MODEL = 'deepseek-v4-flash'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_TIMEOUT_MS = 60_000

export interface DeepSeekProxyDeps {
  /** 测试/E2E 注入 mock 端点（默认官方端点） */
  baseUrl?: string
  /** 测试注入 fetch 实现 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 可注入日期源（系统提示「今天是 X」；单测固定） */
  now?: () => string
}

export function buildSystemPrompt(today: string, accounts: string[]): string {
  const accountLine = accounts.length > 0
    ? `已知账户（优先使用，新账户仅在必要时光用）：${accounts.join(', ')}`
    : '无已知账户，可自由创建新账户'
  return [
    '你是 BeanWise 的复式记账助手，将用户的自然语言描述转换为 Beancount 记账交易。',
    `今天是 ${today}。`,
    accountLine,
    '规则：',
    '1. 每笔交易必须借贷平衡（各记账行金额合计为零）。',
    '2. 日期缺省时用今天；金额缺省时用最合理的推断值。',
    '3. 只调用 add_entries 工具，不要返回任何普通文本。'
  ].join('\n')
}

export class DeepSeekProxy {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => string

  constructor(deps: DeepSeekProxyDeps = {}) {
    this.baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = deps.now ?? (() => { const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` })
  }

  async parse(apiKey: string, text: string, accounts: string[]): Promise<AiParseResult> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: buildSystemPrompt(this.now(), accounts) },
            { role: 'user', content: text }
          ],
          tools: [AI_TOOL],
          tool_choice: { type: 'function', function: { name: AI_TOOL_NAME } }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        return { ok: false, error: 'AI 请求超时，请稍后重试' }
      }
      return { ok: false, error: '网络错误，无法连接 AI 服务' }
    }

    const statusError = mapHttpStatus(res.status)
    if (statusError) return { ok: false, error: statusError }

    let data: unknown
    try {
      data = await res.json()
    } catch {
      return { ok: false, error: 'AI 服务响应异常' }
    }

    const toolCalls = (data as { choices?: Array<{ message?: { tool_calls?: unknown } }> })?.choices?.[0]?.message?.tool_calls
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return { ok: false, error: 'AI 未返回结构化指令，请换一种说法重试' }
    }
    const argsJson = (toolCalls[0] as { function?: { arguments?: unknown } })?.function?.arguments
    let args: unknown
    try {
      args = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson
    } catch {
      return { ok: false, error: 'AI 输出无法解析为 JSON' }
    }

    const parsed = addEntriesToolSchema.safeParse(args)
    if (!parsed.success) {
      return { ok: false, error: `AI 输出不符合录入格式：${formatAiValidationError(parsed.error)}` }
    }
    return { ok: true, drafts: parsed.data.entries }
  }
}

/** HTTP 状态 → 中文提示（null = 正常，继续解析响应体） */
export function mapHttpStatus(status: number): string | null {
  if (status === 401) return 'API Key 无效，请检查 AI 设置'
  if (status === 402) return 'DeepSeek 账户余额不足'
  if (status === 429 || status >= 500) return 'AI 服务繁忙，请稍后重试'
  return null
}
