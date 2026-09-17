/**
 * 账户库条目的结构化校验/规范化（从 ipc-handlers-accounts.ts 抽出，M11 同步并入账户库一起提交）。
 *
 * 抽出的动机同 excel/template-normalize.ts：
 * 1. 纯函数、无 IO——同步合并引擎在落盘前用它校验合并结果；
 * 2. `normalizeAccounts` 是逐字段白名单构造（固定键序），其输出即账户条目的**规范形式**，
 *    合并时用它做「两侧是否为同一条目」的比较基准。
 */
import type { AccountEntry } from '../../shared/ipc'

const ACCOUNT_RE = /^[A-Z]\S*:\S*$/
const MAX_NAME_LEN = 100
const MAX_DESC_LEN = 200
const MAX_ACCOUNTS = 500
const MAX_ACCOUNT_LEN = 200

export function normalizeAccounts(raw: unknown): AccountEntry[] {
  if (!Array.isArray(raw)) throw new Error('accounts 必须为数组')
  const entries: AccountEntry[] = raw.map((item, idx) => {
    if (typeof item !== 'object' || item === null) throw new Error(`accounts[${idx}] 必须为对象`)
    const e = item as Record<string, unknown>
    if (typeof e.id !== 'number' || !Number.isInteger(e.id) || e.id < 0) {
      throw new Error(`accounts[${idx}].id 必须为非负整数`)
    }
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.trim().length > MAX_NAME_LEN) {
      throw new Error(`accounts[${idx}].name 不能为空且不超过 ${MAX_NAME_LEN} 字符`)
    }
    const description = typeof e.description === 'string' ? e.description.trim() : ''
    if (description.length > MAX_DESC_LEN) {
      throw new Error(`accounts[${idx}].description 长度不能超过 ${MAX_DESC_LEN} 字符`)
    }
    const value = typeof e.value === 'string' ? e.value.trim() : ''
    if (!value || !ACCOUNT_RE.test(value)) throw new Error(`accounts[${idx}].value 非法：${e.value}`)
    if (value.length > MAX_ACCOUNT_LEN) throw new Error(`accounts[${idx}].value 长度不能超过 ${MAX_ACCOUNT_LEN} 字符`)
    // 批次 I：enabled 停用标记透传（非 boolean 视为未设置；undefined 序列化时省略）
    const enabled = typeof e.enabled === 'boolean' ? e.enabled : undefined
    // ADR 23：counterparty 往来类标志透传（同上——本函数逐字段白名单构造，
    // 不显式透传的字段会在保存时被静默丢弃）
    const counterparty = typeof e.counterparty === 'boolean' ? e.counterparty : undefined
    return {
      id: e.id,
      name: e.name.trim(),
      value,
      description,
      ...(enabled === undefined ? {} : { enabled }),
      ...(counterparty === undefined ? {} : { counterparty })
    }
  })
  const values = entries.map((e) => e.value)
  if (new Set(values).size !== values.length) throw new Error('账户路径不能重复')
  if (entries.length > MAX_ACCOUNTS) throw new Error(`最多配置 ${MAX_ACCOUNTS} 个账户`)
  return entries.sort((a, b) => a.id - b.id)
}

/**
 * 账户条目的规范体（去 id）：合并时判断「同一账户两侧内容是否一致」的比较基准。
 * `normalizeAccounts` 的键序固定，故 JSON.stringify 逐字节可比。
 */
export function canonicalAccountBody(entry: AccountEntry): string {
  const [normalized] = normalizeAccounts([entry])
  const { id: _id, ...body } = normalized
  return JSON.stringify(body)
}
