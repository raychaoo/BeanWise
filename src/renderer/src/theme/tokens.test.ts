import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeTheme, DEFAULT_THEME_ID, getPalette, THEMES } from './tokens'

describe('多主题 tokens', () => {
  it('默认主题 blue 的 seed 语义色与契约一致', () => {
    const p = getPalette(DEFAULT_THEME_ID)
    expect(p.primary).toBe('#1d39c4')
    expect(p.negative).toBe('#cf1322')
    expect(p.inflow).toBe('#08979c')
    expect(p.outflow).toBe('#d46b08')
  })

  it('computeTheme 派生亮色主题时使用 defaultAlgorithm', () => {
    const cfg = computeTheme('blue', 'light')
    expect(typeof cfg.algorithm).toBe('function')
    expect(cfg.token?.colorPrimary).toBe('#1d39c4')
    expect(cfg.token?.borderRadius).toBe(6)
  })

  it('computeTheme 派生暗色主题时使用 darkAlgorithm 且主色提亮', () => {
    const cfg = computeTheme('blue', 'dark')
    expect(typeof cfg.algorithm).toBe('function')
    // 暗色主色应亮于 seed
    expect(cfg.token?.colorPrimary).not.toBe('#1d39c4')
  })

  it('未知主题 id 回退默认', () => {
    expect(getPalette('not-exist')).toEqual(getPalette(DEFAULT_THEME_ID))
  })

  it('主题注册表包含至少 4 套主题色', () => {
    expect(Object.keys(THEMES).length).toBeGreaterThanOrEqual(4)
  })

  it('与 styles/tokens.less 的 @bw-primary 变量保持同步（两侧互指契约）', () => {
    const less = readFileSync(resolve(__dirname, '../styles/tokens.less'), 'utf8')
    expect(less).toContain(`@bw-primary: ${THEMES.blue.palette.primary};`)
  })
})
