import { describe, expect, it } from 'vitest'
import type { TxKind } from '../../../../shared/ipc'
import { TX_KIND_META, accountDisplay, amountDisplay } from './entryRowDisplay'

/** 账户库中文名映射（未命中回落路径本身，与 EntriesView 的 nameOf 同口径） */
const LABELS: Record<string, string> = {
  'Expenses:Food': '餐饮',
  'Assets:Bank:ZSYH': '招商银行',
  'Assets:WeChat:Pay': '微信支付'
}
const nameOf = (v: string): string => LABELS[v] ?? v

/** 明细行最小构造（只取两个函数用到的字段） */
type Row = Parameters<typeof accountDisplay>[0] & Parameters<typeof amountDisplay>[0]

const row = (patch: Partial<Row> = {}): Row => ({
  pnlAccount: null,
  flowFrom: [],
  flowTo: [],
  account: null,
  amount: null,
  currency: null,
  flowAmount: null,
  txKind: null,
  ...patch
})

describe('accountDisplay（明细页「账户」列取值）', () => {
  it('有损益腿的交易 → pnlAccount 的中文名（raw 保留路径供 Tooltip）', () => {
    expect(accountDisplay(row({ pnlAccount: 'Expenses:Food' }), nameOf)).toEqual({
      label: '餐饮',
      raw: 'Expenses:Food'
    })
  })

  it('无映射时 label === raw（上层据此省掉 Tooltip）', () => {
    const cell = accountDisplay(row({ pnlAccount: 'Expenses:Unknown' }), nameOf)
    expect(cell).toEqual({ label: 'Expenses:Unknown', raw: 'Expenses:Unknown' })
  })

  it('账内搬移 → 「流出 → 流入」账户串（负腿在前，按账户类型语义即钱从哪到哪）', () => {
    expect(
      accountDisplay(row({ flowFrom: ['Assets:Bank:ZSYH'], flowTo: ['Assets:WeChat:Pay'] }), nameOf)
    ).toEqual({ label: '招商银行 → 微信支付', raw: 'Assets:Bank:ZSYH → Assets:WeChat:Pay' })
  })

  it('多腿搬移 → 同侧账户用「、」串联，两侧用「→」（不误读成一串流水线）', () => {
    const cell = accountDisplay(
      row({ flowFrom: ['Assets:Bank:ZSYH', 'Assets:WeChat:Pay'], flowTo: ['Expenses:Food'] }),
      nameOf
    )
    expect(cell?.label).toBe('招商银行、微信支付 → 餐饮')
  })

  it('Open 条目（无分录、只有自身账户）→ 显示该账户', () => {
    expect(accountDisplay(row({ account: 'Assets:Bank:ZSYH' }), nameOf)?.label).toBe('招商银行')
  })

  it('三路皆空 → null（渲染为「—」，如 Balance/Note 条目）', () => {
    expect(accountDisplay(row({}), nameOf)).toBeNull()
  })

  it('损益类目优先于 Open 账户字段：交易行不因 entries.account 为空而漏显示', () => {
    const cell = accountDisplay(row({ pnlAccount: 'Expenses:Food', account: 'Assets:Bank:ZSYH' }), nameOf)
    expect(cell?.label).toBe('餐饮')
  })
})

describe('amountDisplay（明细页「金额」列取值）', () => {
  it('损益金额 → 千分位 + 币种后缀；kind 透出给渲染层着色', () => {
    expect(amountDisplay(row({ amount: '-1234.5', currency: 'CNY', txKind: 'expense' }))).toEqual({
      text: '-1,234.5 CNY',
      kind: 'expense'
    })
    expect(amountDisplay(row({ amount: '25', currency: 'CNY', txKind: 'income' }))).toEqual({
      text: '25 CNY',
      kind: 'income'
    })
  })

  it('无币种 → 仅金额（不输出尾随空格）', () => {
    expect(amountDisplay(row({ amount: '-15' }))?.text).toBe('-15')
  })

  it('账内搬移 → 显发生额（借出：正数且不是收入，着色只能靠 kind）', () => {
    expect(amountDisplay(row({ flowAmount: '3000', currency: 'CNY', txKind: 'lend' }))).toEqual({
      text: '3,000 CNY',
      kind: 'lend'
    })
  })

  it('withCurrency:false → 币种由独立列承载，金额不带后缀（对账明细账）', () => {
    expect(amountDisplay(row({ flowAmount: '3000', currency: 'CNY' }), { withCurrency: false })?.text).toBe('3,000')
  })

  it('损益金额优先于搬移发生额（两者互斥，同真时以损益为准）', () => {
    expect(amountDisplay(row({ amount: '-15', flowAmount: '3000' }))?.text).toBe('-15')
  })

  it('两者皆空 → null（渲染为「—」，如 Open 条目）', () => {
    expect(amountDisplay(row({}))).toBeNull()
  })
})

describe('TX_KIND_META（类型标记：色之外的第二重标记）', () => {
  const ALL_KINDS: TxKind[] = [
    'income',
    'expense',
    'lend',
    'borrow',
    'recover',
    'repay',
    'transfer',
    'equity'
  ]

  it('8 种交易类型全部配有标签/色调/说明（漏配会让金额列静默不带标记）', () => {
    for (const k of ALL_KINDS) {
      expect(TX_KIND_META[k]?.label, k).toBeTruthy()
      expect(TX_KIND_META[k]?.hint, k).toBeTruthy()
      expect(['income', 'expense', 'lend', 'neutral'], k).toContain(TX_KIND_META[k]?.tone)
    }
    expect(Object.keys(TX_KIND_META).sort()).toEqual([...ALL_KINDS].sort())
  })

  it('标签两两不同（标签是色觉障碍用户唯一的区分手段）', () => {
    const labels = ALL_KINDS.map((k) => TX_KIND_META[k].label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('往来四型共用「靛」色调：只变债权债务，不产生损益', () => {
    for (const k of ['lend', 'borrow', 'recover', 'repay'] as TxKind[]) {
      expect(TX_KIND_META[k].tone, k).toBe('lend')
    }
  })
})
