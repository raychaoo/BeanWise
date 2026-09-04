/**
 * M7-T3：ai 域 handler 测试（内存 token store + :memory: SQLite + 注入 fetchImpl）。
 * 覆盖：get-status 配置态、save-config 校验/存储、clear-config、parse 全分支
 * （未配置拒绝 / 入参校验 reject / accounts 注入请求体 / 代理异常透传）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDrizzle, openDatabase, type DrizzleDb } from '../../db/index'
import { entries, postings } from '../../db/schema'
import type { IpcRegistrar } from '../ledger/ipc-handlers'
import { registerAiHandlers, type AiDeps } from './ipc-handlers-ai'
import type { TokenStore } from '../../stores/token-store'

class MemoryTokenStore implements TokenStore {
  value: string | null = null
  load(): string | null { return this.value }
  save(v: string): void { this.value = v }
  clear(): void { this.value = null }
}

function memoryIpc(): { ipc: IpcRegistrar; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return { ipc: { handle: (ch, fn) => { handlers.set(ch, fn) } }, handlers }
}

/** 注入一笔 Open 条目 + 一条 posting（listAccounts 数据源） */
function seedAccount(db: DrizzleDb, account: string): void {
  const row = db.insert(entries).values({ type: 'Open', date: '2026-01-01', account }).returning({ id: entries.id }).get()
  db.insert(postings).values({ entryId: row.id, account, unitsNumber: '0', unitsCurrency: 'CNY' }).run()
}

function setup(overrides: Partial<AiDeps> = {}) {
  const db = createDrizzle(openDatabase(':memory:'))
  seedAccount(db, 'Expenses:Food')
  const tokens = new MemoryTokenStore()
  const { ipc, handlers } = memoryIpc()
  const fetchImpl = vi.fn()
  registerAiHandlers(ipc, { db, tokens, fetchImpl: fetchImpl as unknown as typeof fetch, ...overrides })
  return { db, tokens, handlers, fetchImpl }
}

const invoke = async (handlers: Map<string, (...args: unknown[]) => unknown>, channel: string, raw?: unknown): Promise<unknown> =>
  await handlers.get(channel)!({} as never, raw)

describe('ai:get-status', () => {
  it('未配置 → configured:false + model', async () => {
    const { handlers } = setup()
    const r = await invoke(handlers, 'ai:get-status') as { configured: boolean; model: string }
    expect(r.configured).toBe(false)
    expect(r.model).toBe('deepseek-v4-flash')
  })

  it('已配置 → configured:true', async () => {
    const { handlers, tokens } = setup()
    tokens.save('sk-1')
    const r = await invoke(handlers, 'ai:get-status') as { configured: boolean }
    expect(r.configured).toBe(true)
  })
})

describe('ai:save-config / ai:clear-config', () => {
  it('保存 → token store 落值', async () => {
    const { handlers, tokens } = setup()
    const r = await invoke(handlers, 'ai:save-config', { apiKey: 'sk-123' }) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(tokens.load()).toBe('sk-123')
  })

  it('非法入参（非字符串/空/超长）→ reject', async () => {
    const { handlers } = setup()
    await expect(invoke(handlers, 'ai:save-config', { apiKey: '' })).rejects.toThrow('1~200')
    await expect(invoke(handlers, 'ai:save-config', { apiKey: 'x'.repeat(201) })).rejects.toThrow('1~200')
    await expect(invoke(handlers, 'ai:save-config', { apiKey: 42 })).rejects.toThrow()
    await expect(invoke(handlers, 'ai:save-config', null)).rejects.toThrow()
  })

  it('clear → token store 清空', async () => {
    const { handlers, tokens } = setup()
    tokens.save('sk-1')
    await invoke(handlers, 'ai:clear-config')
    expect(tokens.load()).toBeNull()
  })
})

describe('ai:parse', () => {
  it('未配置 Key → ok:false 中文提示（不发请求）', async () => {
    const { handlers, fetchImpl } = setup()
    const r = await invoke(handlers, 'ai:parse', { text: '午饭 25.5' }) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('尚未配置')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('入参非法（空/超长/非字符串）→ reject', async () => {
    const { handlers, tokens } = setup()
    tokens.save('sk-1')
    await expect(invoke(handlers, 'ai:parse', { text: '   ' })).rejects.toThrow()
    await expect(invoke(handlers, 'ai:parse', { text: 'x'.repeat(2001) })).rejects.toThrow('2000')
    await expect(invoke(handlers, 'ai:parse', { text: 42 })).rejects.toThrow()
  })

  it('成功：accounts 注入请求体（来自 SQLite 索引）', async () => {
    // 简报偏差（M7-T3 报告）：补配置 Key——无 Key 时 handler 走「尚未配置」早退，请求不会发出
    const { handlers, fetchImpl, tokens } = setup()
    tokens.save('sk-1')
    fetchImpl.mockResolvedValue({
      status: 200,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ function: { name: 'add_entries', arguments: '{"entries":[]}' } }] } }]
      })
    })
    const r = await invoke(handlers, 'ai:parse', { text: '午饭 25.5' }) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false) // entries:[] 过不了 schema，但请求已发出——验证注入
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.messages[0].content).toContain('Expenses:Food')
  })

  it('代理返回拒绝 → 透传', async () => {
    const { handlers, fetchImpl, tokens } = setup()
    tokens.save('sk-1')
    fetchImpl.mockResolvedValue({ status: 401, json: async () => ({}) })
    const r = await invoke(handlers, 'ai:parse', { text: 'x' }) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('API Key 无效')
  })

  it('代理异常（fetch 拒绝非 AbortError）→ ok:false 透传不抛出', async () => {
    // 简报偏差（M7-T3 报告）：原断言 'boom' 不可达——Task 2 已审批的 DeepSeekProxy 将
    // fetch 拒绝（非 AbortError）在内部映射为「网络错误，无法连接 AI 服务」，错误文本不进 handler
    const { handlers, fetchImpl, tokens } = setup()
    tokens.save('sk-1')
    fetchImpl.mockRejectedValue(new Error('boom'))
    const r = await invoke(handlers, 'ai:parse', { text: 'x' }) as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('网络错误')
  })
})
