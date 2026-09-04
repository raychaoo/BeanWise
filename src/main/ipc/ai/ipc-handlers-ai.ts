/**
 * M7：ai 域四通道（get-status / save-config / clear-config / parse）。
 * 编排：Key 仅主进程持有（safeStorage）→ ai:parse 主进程代理调用 DeepSeek（tool_choice 强制
 * add_entries，ADR 12/13）→ 本地 schema 校验拒绝非法输出 → drafts 回渲染端（复用 AddEntryParams）。
 * 入参校验在 handler 内 throw（reject，与 add-entry/save-file 同约定）；ai:parse 为只读通道
 * （不写文件、不占写锁、不触发自动 push——M6 已裁决）。
 */
import type { AiParseResult, AiStatus, SaveAiConfigParams, SaveAiConfigResult } from '../../../shared/ipc'
import { AI_MODEL, DeepSeekProxy, type DeepSeekProxyDeps } from '../../ai/ai-proxy'
import type { DrizzleDb } from '../../db/index'
import { listAccounts, type IpcRegistrar } from '../ledger/ipc-handlers'
import type { TokenStore } from '../../stores/token-store'

const MAX_AI_TEXT_LEN = 2000
const MAX_API_KEY_LEN = 200

export interface AiDeps extends DeepSeekProxyDeps {
  db: DrizzleDb
  tokens: TokenStore
}

function validateApiKey(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new Error('入参必须为对象')
  const apiKey = (raw as Partial<SaveAiConfigParams>).apiKey
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > MAX_API_KEY_LEN) {
    throw new Error(`API Key 长度必须为 1~${MAX_API_KEY_LEN} 字符`)
  }
  return apiKey
}

function validateAiParseParams(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new Error('入参必须为对象')
  const text = (raw as Partial<{ text: unknown }>).text
  if (typeof text !== 'string') throw new Error('text 必须是字符串')
  const trimmed = text.trim()
  if (trimmed.length < 1) throw new Error('请输入要录入的内容')
  if (trimmed.length > MAX_AI_TEXT_LEN) throw new Error(`输入超过 ${MAX_AI_TEXT_LEN} 字符上限`)
  return trimmed
}

export function registerAiHandlers(ipc: IpcRegistrar, deps: AiDeps): void {
  ipc.handle('ai:get-status', (): AiStatus => ({
    configured: !!deps.tokens.load(),
    model: AI_MODEL
  }))

  ipc.handle('ai:save-config', (_event: unknown, raw: unknown): SaveAiConfigResult => {
    const apiKey = validateApiKey(raw)
    deps.tokens.save(apiKey) // safeStorage 失败 → throw（reject，配置零写入）
    return { ok: true }
  })

  ipc.handle('ai:clear-config', (): { ok: boolean } => {
    deps.tokens.clear()
    return { ok: true }
  })

  ipc.handle('ai:parse', async (_event: unknown, raw: unknown): Promise<AiParseResult> => {
    const text = validateAiParseParams(raw)
    const apiKey = deps.tokens.load()
    if (!apiKey) return { ok: false, error: '尚未配置 DeepSeek API Key，请先在 AI 设置中配置' }
    const proxy = new DeepSeekProxy({ baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, now: deps.now })
    try {
      return await proxy.parse(apiKey, text, listAccounts(deps.db))
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
}
