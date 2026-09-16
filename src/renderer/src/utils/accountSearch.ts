/**
 * 科目搜索匹配（纯函数）：账户页「科目管理」与对账页「科目余额表」共用。
 *
 * 两处都**只做前端过滤**——数据本就全在内存（科目管理持有整份账户库、余额表一次返回全部行），
 * 无需新增 IPC；服务端过滤只在「按账户分页查分录」这类拿不全数据的场景才有必要
 * （对比明细页 keyword/amount，见 ADR 25）。
 *
 * 口径：大小写不敏感的子串匹配（路径为 ASCII，中文名称/用途不受 toLowerCase 影响）；
 * 空白串视为「不约束」——输入框清空即取消该条检索线。
 */
import type { AccountEntry } from '../../../shared/ipc'

/** 检索词归一：去首尾空白 + 小写；调用方直接传输入框原值即可 */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * 大小写不敏感子串匹配（检索词内部归一，传输入框原值即可）；空串恒命中。
 * text 为 null/undefined 视作空串（description 是可选字段）。
 */
export function includesQuery(text: string | null | undefined, rawQuery: string): boolean {
  const q = normalizeQuery(rawQuery)
  return q === '' || (text ?? '').toLowerCase().includes(q)
}

/**
 * 科目管理：**两个输入框两条检索线**——「名称 / 用途」一条、「账户路径」另一条，
 * 两条之间 **AND** 叠加（同明细页「文本搜索 + 金额搜索」的同层 AND 语义，见 ADR 25）。
 * 名称线内 name 与 description 是 OR：用户记得住哪个就搜哪个。
 */
export function matchesAccountSearch(
  entry: Pick<AccountEntry, 'name' | 'description' | 'value'>,
  nameQuery: string,
  pathQuery: string
): boolean {
  const nameHit = includesQuery(entry.name, nameQuery) || includesQuery(entry.description, nameQuery)
  return nameHit && includesQuery(entry.value, pathQuery)
}

/**
 * 科目余额表：**单框**同时匹配账户中文名与原始路径。
 * 无账户库配置时 label === 路径（两条等价）；有配置时用户可能记得中文名也可能记得路径，
 * 只认其中一条都会让人以为「搜不到这个账户」。
 */
export function matchesAccountLabel(label: string, path: string, query: string): boolean {
  return includesQuery(label, query) || includesQuery(path, query)
}
