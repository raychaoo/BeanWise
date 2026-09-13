import { describe, expect, it } from 'vitest'
import { computeLoanLedger, isNewLoanPosting, newLoanId, pickOpenLoanId, type LoanPostingRow } from './loan-links'

const LEND = 'Assets:Receivables:Lend'
const REPAY = 'Liabilities:Loans:Repay'

function row(over: Partial<LoanPostingRow> & { link: string }): LoanPostingRow {
  return {
    entryId: 1,
    date: '2026-01-01',
    account: LEND,
    number: '0',
    currency: 'CNY',
    counterparty: '李志全',
    ...over
  }
}

describe('newLoanId（不透明 ASCII，不派生自内容）', () => {
  it('格式为 lend- + base36 时间 + 10 位随机，且可注入随机源', () => {
    const id = newLoanId(() => 0.5, () => 1000)
    // 'lend-' + base36(1000)='rs' + 10 位随机
    expect(id).toMatch(/^lend-[A-Za-z0-9]{12,40}$/)
    // 固定随机源 → 固定结果（确定性可测）
    expect(newLoanId(() => 0.5, () => 1000)).toBe(id)
    expect(newLoanId(() => 0.25, () => 1000)).not.toBe(id)
  })

  it('中文 / 点 / 斜杠不会出现在 ID 里（beancount link 词法受限）', () => {
    for (let i = 0; i < 50; i++) {
      expect(newLoanId()).toMatch(/^lend-[A-Za-z0-9]{12,40}$/)
    }
  })
})

describe('isNewLoanPosting（往来类账户上的「新增欠款」方向）', () => {
  it('资产侧应收增加 = 新借出；减少 = 还款', () => {
    expect(isNewLoanPosting(LEND, '5000')).toBe(true)
    expect(isNewLoanPosting(LEND, '-4000')).toBe(false)
  })

  it('负债侧相反：借入记负 = 新借入；还回去记正 = 冲减', () => {
    expect(isNewLoanPosting(REPAY, '-2000')).toBe(true)
    expect(isNewLoanPosting(REPAY, '2000')).toBe(false)
  })

  it('零值不算（0 / 0.00 / -0）', () => {
    expect(isNewLoanPosting(LEND, '0')).toBe(false)
    expect(isNewLoanPosting(LEND, '0.00')).toBe(false)
    expect(isNewLoanPosting(LEND, '-0')).toBe(false)
  })

  it('非资产/负债账户恒 false（防误标账户搅乱挂链）', () => {
    expect(isNewLoanPosting('Expenses:Food', '50')).toBe(false)
    expect(isNewLoanPosting('Income:Other', '-50')).toBe(false)
  })
})

describe('computeLoanLedger（按 link 聚合核销状态）', () => {
  it('借出 + 部分还款 → 未结为差额，未结清', () => {
    const loans = computeLoanLedger([
      row({ link: 'lend-a', date: '2026-05-19', number: '5000.00' }),
      row({ link: 'lend-a', date: '2026-07-01', number: '-4000.00', entryId: 2 })
    ])
    expect(loans).toEqual([
      {
        id: 'lend-a',
        counterparty: '李志全',
        date: '2026-05-19',
        currency: 'CNY',
        principal: '5000',
        settled: '4000',
        outstanding: '1000',
        closed: false
      }
    ])
  })

  it('全额还清 → closed；还超了 → outstanding 为负但同样 closed', () => {
    const full = computeLoanLedger([
      row({ link: 'lend-a', number: '555' }),
      row({ link: 'lend-a', date: '2026-02-01', number: '-555', entryId: 2 })
    ])
    expect(full[0]!.outstanding).toBe('0')
    expect(full[0]!.closed).toBe(true)

    const over = computeLoanLedger([
      row({ link: 'lend-b', number: '500' }),
      row({ link: 'lend-b', date: '2026-02-01', number: '-550', entryId: 2 })
    ])
    expect(over[0]!.outstanding).toBe('-50')
    expect(over[0]!.closed).toBe(true)
  })

  it('负债侧取反到「对方欠我」口径（借入 −2000 应记为本金 2000）', () => {
    const loans = computeLoanLedger([
      row({ link: 'lend-c', account: REPAY, number: '-2000' }),
      row({ link: 'lend-c', account: REPAY, date: '2026-03-01', number: '2000', entryId: 2 })
    ])
    expect(loans[0]!.principal).toBe('2000')
    expect(loans[0]!.settled).toBe('2000')
    expect(loans[0]!.closed).toBe(true)
  })

  it('按日期升序输出（FIFO 依赖该顺序）；无 counterparty 的交易对象为 null', () => {
    const loans = computeLoanLedger([
      row({ link: 'lend-late', date: '2026-06-01', counterparty: null }),
      row({ link: 'lend-early', date: '2026-05-01' })
    ])
    expect(loans.map((l) => l.id)).toEqual(['lend-early', 'lend-late'])
    expect(loans[1]!.counterparty).toBeNull()
  })

  it('空输入 → 空数组', () => {
    expect(computeLoanLedger([])).toEqual([])
  })
})

describe('pickOpenLoanId（FIFO 取最早的未结）', () => {
  const loans = [
    row({ link: 'lend-1', date: '2026-05-01' }),
    row({ link: 'lend-2', date: '2026-06-01' }),
    row({ link: 'lend-3', date: '2026-07-01', counterparty: '王五' })
  ]
  const ledger = computeLoanLedger([
    ...loans.map((r) => ({ ...r, number: '100' })),
    // 第一笔已还清 → 应跳过，取第二笔
    row({ link: 'lend-1', date: '2026-05-02', number: '-100', entryId: 9 })
  ])

  it('跳过已结清、跳过他人，取同对象最早的未结', () => {
    expect(pickOpenLoanId(ledger, '李志全')).toBe('lend-2')
    expect(pickOpenLoanId(ledger, '王五')).toBe('lend-3')
  })

  it('无未结（或对象不存在）→ undefined', () => {
    expect(pickOpenLoanId(ledger, '张三')).toBeUndefined()
    expect(pickOpenLoanId([], '李志全')).toBeUndefined()
  })
})
