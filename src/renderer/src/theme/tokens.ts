/**
 * antd Design Token 单源（批次 A 契约，B/C/D/E 全部消费）。
 * 与 src/renderer/src/styles/tokens.less 的同名 @bw-* 变量保持同步（两侧文件头互指，有单测断言）。
 * antd token 需真实色值（色板算法不能用 CSS var），Less 侧同名变量作运行期兜底。
 */
import type { ThemeConfig } from 'antd'

/** 功能语义色：流入=青 / 流出=橙 / 负数=红（红色语义唯一化，不用于支出） */
export const BW_COLORS = {
  primary: '#1d39c4',
  inflow: '#08979c',
  outflow: '#d46b08',
  negative: '#cf1322',
  bgLayout: '#f5f7fa',
  textBase: '#0f172a'
} as const

export const THEME_TOKENS: ThemeConfig = {
  token: {
    colorPrimary: BW_COLORS.primary,
    colorSuccess: '#389e0d',
    colorWarning: BW_COLORS.outflow,
    colorError: BW_COLORS.negative,
    colorInfo: BW_COLORS.inflow,
    colorTextBase: BW_COLORS.textBase,
    colorBgLayout: BW_COLORS.bgLayout,
    borderRadius: 6,
    fontSize: 14,
    wireframe: false
  }
}
