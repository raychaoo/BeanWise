/**
 * 多主题 token 消费钩子（用于非 React 组件场景：图表/Monaco/命令式代码）。
 * 返回当前主题模式下的语义色（已做暗色校准）。
 */
import { useMemo } from 'react'
import { useThemeContext } from './ThemeProvider'
import { computeTheme, getPalette } from './tokens'

export interface MultiThemeColors {
  primary: string
  inflow: string
  outflow: string
  negative: string
}

/** 当前主题的语义色（图表层使用） */
export function useSemanticColors(): MultiThemeColors {
  const { themeId, mode } = useThemeContext()
  return useMemo(() => {
    const cfg = computeTheme(themeId, mode)
    const t = cfg.token ?? {}
    return {
      primary: String(t.colorPrimary ?? '#1d39c4'),
      inflow: String(t.colorInfo ?? '#08979c'),
      outflow: String(t.colorWarning ?? '#d46b08'),
      negative: String(t.colorError ?? '#cf1322')
    }
  }, [themeId, mode])
}

/** 当前主题的 antd token 调色板（未校准的原始 seed） */
export function usePalette() {
  const { themeId } = useThemeContext()
  return useMemo(() => getPalette(themeId), [themeId])
}
