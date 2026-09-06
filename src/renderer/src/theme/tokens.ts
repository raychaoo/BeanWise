/**
 * 多主题色 + 明暗双档 的 antd Design Token 单源。
 *
 * 体系：
 * - themes: 多套主题色（appearance = 主题 id），每套持有 seed 语义色（primary/inflow/outflow/negative）
 * - computeTheme(id, mode): 根据 appearance + light|dark 派生完整 antd ThemeConfig
 *   - 亮色用 antd defaultAlgorithm
 *   - 暗色用 darkAlgorithm，并对 seed 语义色做 WCAG AA 对比度校准提亮
 *
 * 组件与样式一律通过 antd-style 的 createStyles 消费 token，不再直接 import 色值。
 * 图表/Monaco 层消费 exported THEMES 表（见 themeThemes）。
 */
import { theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'

/** 一套主题色的 seed 语义色（primary 为主色，inflow/outflow/negative 为固定语义色，不随主色变化） */
export interface ThemePalette {
  /** 主色：品牌/主 CTA/现金流线/主强调 */
  primary: string
  /** 流入语义色（贷方/收入/正数，青） */
  inflow: string
  /** 流出语义色（借方/支出/方向，橙） */
  outflow: string
  /** 负数语义色（赤字/亏损/错误，红，语义唯一化） */
  negative: string
}

/** 负数语义色固定（红色语义唯一化，不随主题色变化） */
const NEGATIVE = '#cf1322'
const NEGATIVE_DARK = '#ff4d4f'

/**
 * 主题色注册表。新增主题只需在此追加一项，无需改其它代码。
 * 主色 primary 决定品牌调性；inflow/outflow 为语义色，建议各主题微调以保证 4.5:1 对比度。
 */
export const THEMES: Record<string, { label: string; palette: ThemePalette }> = {
  blue: {
    label: '商务蓝',
    palette: { primary: '#1d39c4', inflow: '#08979c', outflow: '#d46b08', negative: NEGATIVE }
  },
  green: {
    label: '森绿',
    palette: { primary: '#389e0d', inflow: '#08979c', outflow: '#d46b08', negative: NEGATIVE }
  },
  purple: {
    label: '紫霞',
    palette: { primary: '#9254de', inflow: '#08979c', outflow: '#d46b08', negative: NEGATIVE }
  },
  pink: {
    label: '樱粉',
    palette: { primary: '#f759ab', inflow: '#08979c', outflow: '#d46b08', negative: NEGATIVE }
  }
}

export type ThemeId = keyof typeof THEMES

export const DEFAULT_THEME_ID: ThemeId = 'blue'

/** 主题 id 列表（供选择器渲染） */
export const THEME_LIST = Object.entries(THEMES).map(([id, v]) => ({ id: id as ThemeId, label: v.label }))

/** 根据主题 id 取调色板（不存在则回退默认） */
export function getPalette(id: string): ThemePalette {
  return THEMES[id]?.palette ?? THEMES[DEFAULT_THEME_ID].palette
}

/**
 * 暗色模式下 seed 语义色的 WCAG AA 对比度校准（在暗色表面提亮）。
 * primary 的提亮算法：转 HSL 后提升 L，保证与暗色背景 >= 4.5:1。
 */
function lightenForDark(hex: string, targetL = 0.68): string {
  const { h, s, l } = hexToHsl(hex)
  return hslToHex(h, s, Math.max(l, targetL))
}

/** 派生完整 antd ThemeConfig */
export function computeTheme(id: string, mode: 'light' | 'dark'): ThemeConfig {
  const { primary, inflow, outflow, negative } = getPalette(id)

  const seed = {
    primary,
    inflow,
    outflow,
    negative
  }

  // 暗色档：对 primary/inflow/outflow 提亮，negative 用固定校准色
  const palette = mode === 'dark'
    ? {
        primary: lightenForDark(seed.primary),
        inflow: lightenForDark(seed.inflow),
        outflow: lightenForDark(seed.outflow),
        negative: NEGATIVE_DARK
      }
    : seed

  return {
    token: {
      colorPrimary: palette.primary,
      colorInfo: palette.inflow,
      colorWarning: palette.outflow,
      colorError: palette.negative,
      colorSuccess: '#389e0d',
      borderRadius: 6,
      fontSize: 14,
      wireframe: false
    },
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm
  }
}

// ---- 颜色工具（纯函数，无依赖）----
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let c = hex.replace('#', '')
  if (c.length === 3) c = c.split('').map((x) => x + x).join('')
  const r = parseInt(c.slice(0, 2), 16) / 255
  const g = parseInt(c.slice(2, 4), 16) / 255
  const b = parseInt(c.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      default:
        h = ((r - g) / d + 4) / 6
    }
  }
  return { h: h * 360, s, l }
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
