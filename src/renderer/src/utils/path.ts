/**
 * 账本（工作目录）显示名工具：按 / 与 \ 双分隔符取末段（渲染端路径可能来自 Windows 与 POSIX）。
 */

/** 'C:\\a\\b' → 'b'，'/x/y' → 'y'，'name' → 'name'；末尾分隔符与空段忽略 */
export function basenamePath(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}
