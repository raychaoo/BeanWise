/**
 * 账户页「科目管理」的分 tab 取数（性能）。
 * 原实现 `activeTab === 'all' ? configured : configured.filter(...)` 在渲染体内每帧重算，
 * 且六个 tab pane 共用同一份结果——六个 pane 各挂一张全量表，任何重渲染都会全量重跑。
 * 这里改为：每个 tab 一份数组，且「本 tab 的行与上一轮逐元素相同（同一批对象、同一顺序）」
 * 时沿用旧数组引用。配合 memo 化的表格组件，编辑某一行只会让**含该行的 tab** 重渲染，
 * 切换 tab 时未变化的 pane 整棵跳过。
 */
import { ACCOUNT_TYPES, accountType } from '../../../shared/account'
import type { AccountEntry } from '../../../shared/ipc'

export const ACCOUNT_TAB_KEYS = ['all', ...ACCOUNT_TYPES] as const

export type AccountTabKey = typeof ACCOUNT_TAB_KEYS[number]

export type AccountTabData = Record<AccountTabKey, AccountEntry[]>

/**
 * 按账户顶层类型切分：`all` 为全量，五大类各自一份。
 * 未知前缀（如 `History:X`）只落在 `all` 里——与旧的 `filter` 兜底一致，保证条目不会消失。
 */
export function groupAccountsByTab(configured: AccountEntry[]): AccountTabData {
  const data: AccountTabData = {
    all: configured,
    Assets: [],
    Liabilities: [],
    Equity: [],
    Income: [],
    Expenses: []
  }
  for (const entry of configured) {
    const type = accountType(entry.value)
    if (type) data[type].push(entry)
  }
  return data
}

function sameItems(a: AccountEntry[], b: AccountEntry[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * 逐 tab 比较，内容一致的沿用 `prev` 的数组引用（内容一致即元素逐个引用相同，故等价替换）。
 * 返回的对象是新的，各 tab 的数组引用则尽量保持稳定——这是 memo 表格能跳过渲染的前提。
 */
export function reuseUnchangedTabs(prev: AccountTabData, next: AccountTabData): AccountTabData {
  const merged = { ...next }
  for (const key of ACCOUNT_TAB_KEYS) {
    if (sameItems(prev[key], next[key])) merged[key] = prev[key]
  }
  return merged
}
