/**
 * 多主题 hook：管理 appearance（主题色 id）+ themeMode（light/dark）。
 * 持久化走 localStorage，键名与主进程隔离。
 * 初始值：localStorage → 系统 prefers-color-scheme / 默认蓝。
 */
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_THEME_ID, type ThemeId } from './tokens'

export type ThemeMode = 'light' | 'dark'

const STORAGE_THEME = 'beanwise-theme-id'
const STORAGE_MODE = 'beanwise-theme-mode'

function getInitialTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_THEME)
    if (saved) return saved as ThemeId
  } catch {
    /* 降级 */
  }
  return DEFAULT_THEME_ID
}

function getInitialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_MODE)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* 降级 */
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

export interface UseThemeResult {
  themeId: ThemeId
  mode: ThemeMode
  isDark: boolean
  setTheme(id: ThemeId): void
  setMode(mode: ThemeMode): void
  toggleMode(): void
}

export function useTheme(): UseThemeResult {
  const [themeId, setThemeId] = useState<ThemeId>(getInitialTheme)
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode)

  // 持久化 + 同步 data-* 属性（供 createGlobalStyle 与残存 Less 参考）
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_THEME, themeId)
      localStorage.setItem(STORAGE_MODE, mode)
    } catch {
      /* 忽略 */
    }
    const root = document.documentElement
    root.setAttribute('data-theme-id', themeId)
    root.setAttribute('data-theme-mode', mode)
    root.setAttribute('data-theme', mode) // 兼容现有选择器
  }, [themeId, mode])

  const setTheme = useCallback((id: ThemeId) => setThemeId(id), [])
  const setMode = useCallback((m: ThemeMode) => setModeState(m), [])
  const toggleMode = useCallback(() => setModeState((prev) => (prev === 'dark' ? 'light' : 'dark')), [])

  return { themeId, mode, isDark: mode === 'dark', setTheme, setMode, toggleMode }
}
