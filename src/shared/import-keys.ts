/**
 * 导入账户映射复合键（M10）：同一交易类型/支付方式文本在不同维度下需要分开映射时，
 * 用「主维度@辅维度」作为映射键，例如 转账@零钱、零钱@转账。
 */

export const MAPPING_KEY_SEP = '@'

/** 交易类型映射键：type 为主、method 为辅（method 为空则退化为 type）。 */
export function typeMapKey(type: string, method: string): string {
  const t = type.trim()
  const m = method.trim()
  return t && m ? `${t}${MAPPING_KEY_SEP}${m}` : t
}

/** 支付方式映射键：method 为主、type 为辅（type 为空则退化为 method）。 */
export function methodMapKey(method: string, type: string): string {
  const m = method.trim()
  const t = type.trim()
  return m && t ? `${m}${MAPPING_KEY_SEP}${t}` : m || t
}
