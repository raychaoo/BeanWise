import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BW_COLORS, THEME_TOKENS } from './tokens'

describe('THEME_TOKENS', () => {
  it('与契约色值一致', () => {
    expect(BW_COLORS.primary).toBe('#1d39c4')
    expect(BW_COLORS.negative).toBe('#cf1322')
    expect(THEME_TOKENS.token?.colorPrimary).toBe(BW_COLORS.primary)
    expect(THEME_TOKENS.token?.borderRadius).toBe(6)
  })

  it('与 styles/tokens.less 的同名变量保持同步（两侧互指契约）', () => {
    const less = readFileSync(resolve(__dirname, '../styles/tokens.less'), 'utf8')
    expect(less).toContain(`@bw-primary: ${BW_COLORS.primary};`)
    expect(less).toContain(`@bw-inflow: ${BW_COLORS.inflow};`)
    expect(less).toContain(`@bw-outflow: ${BW_COLORS.outflow};`)
    expect(less).toContain(`@bw-negative: ${BW_COLORS.negative};`)
    expect(less).toContain(`@bw-bg-layout: ${BW_COLORS.bgLayout};`)
    expect(less).toContain(`@bw-text-base: ${BW_COLORS.textBase};`)
  })
})
