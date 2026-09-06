/**
 * 多主题 Provider：基于 antd-style 的 ThemeProvider 封装。
 *
 * 能力：
 * - appearance = 主题色 id（blue/green/purple/pink），可扩展
 * - themeMode = light/dark，theme 由 computeTheme(id, mode) 派生
 * - customToken 暴露语义色（inflow/outflow/negative），供 createStyles 消费
 * - 同时应用 antd locale
 *
 * 子树通过 useTheme() 获取 { themeId, mode, setTheme, setMode, toggleMode }。
 */
import { ConfigProvider } from 'antd'
import type { ConfigProviderProps } from 'antd'
import { ThemeProvider as AntdStyleThemeProvider } from 'antd-style'
import { createContext, useContext } from 'react'
import { computeTheme, getPalette } from './tokens'
import { useTheme, type UseThemeResult } from './useTheme'

const ThemeContext = createContext<UseThemeResult | null>(null)

export function ThemeProvider({
  locale,
  children
}: {
  locale?: ConfigProviderProps['locale']
  children: React.ReactNode
}) {
  const themeState = useTheme()
  const { themeId, mode } = themeState

  // antd 主题配置：根据 appearance + mode 派生
  const themeConfig = computeTheme(themeId, mode)

  // 自定义 token：语义色（inflow/outflow/negative）跟随主题，供 createStyles 消费
  const palette = getPalette(themeId)

  return (
    <ConfigProvider locale={locale} theme={themeConfig}>
      <AntdStyleThemeProvider
        theme={themeConfig}
        customToken={{
          inflow: palette.inflow,
          outflow: palette.outflow,
          negative: palette.negative
        }}
      >
        <ThemeContext.Provider value={themeState}>{children}</ThemeContext.Provider>
      </AntdStyleThemeProvider>
    </ConfigProvider>
  )
}

/** 消费多主题状态（必须在 ThemeProvider 子树内使用） */
export function useThemeContext(): UseThemeResult {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useThemeContext 必须在 ThemeProvider 子树内使用')
  return ctx
}
