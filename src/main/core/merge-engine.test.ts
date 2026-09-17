/**
 * 合并引擎单测（M11）：三态语义 + 账本 diff3 + JSON 结构化并集 + **收敛性属性**。
 *
 * 收敛性是这套合并的命门：机器 A 拉取时 ours=A/theirs=B，机器 B 拉取时 ours=B/theirs=A，
 * 两者必须得出逐字节相同的结果，否则每次同步都产生新差异（来回 ping-pong）。
 * 因此这里对每类输入都断言「交换 ours/theirs 结果不变」+「快速前进恒等」+「二次归并幂等」。
 */
import { describe, expect, it } from 'vitest'
import type { AccountEntry, ExcelImportTemplate } from '../../shared/ipc'
import { SYNC_ACCOUNTS_FILE, SYNC_GITIGNORE_FILE, SYNC_LEDGER_FILE, SYNC_TEMPLATES_FILE } from '../../shared/sync-files'
import { mergeForPath, mergeThreeWay, mergeTrackedFiles, textDiverged, type FileTriple, type MergeOutcome } from './merge-engine'

const LEDGER = SYNC_LEDGER_FILE
const ACCOUNTS = SYNC_ACCOUNTS_FILE
const TEMPLATES = SYNC_TEMPLATES_FILE

// ---- 夹具 ----

const acct = (id: number, value: string, name = value, extra: Partial<AccountEntry> = {}): AccountEntry => ({
  id,
  name,
  value,
  description: '',
  ...extra
})

const accountsFile = (...entries: AccountEntry[]): string => JSON.stringify({ accounts: entries }, null, 2)

function template(source: string, id: string, name = source): ExcelImportTemplate {
  return {
    id,
    name,
    source,
    fieldMapping: { dateColumn: '日期', amountColumn: '金额' },
    directionRule: { mode: 'column', neutralKeywords: [] },
    accountMapping: {
      expenseByType: {},
      incomeByType: {},
      sourceByMethod: {},
      cashAccountByMethod: {},
      fallbackExpenseAccount: 'Expenses:Unknown',
      fallbackSourceAccount: 'Assets:Unknown',
      fallbackIncomeAccount: 'Income:Unknown',
      fallbackCashAccount: 'Assets:Cash'
    },
    strictNewAccounts: false
  }
}

const templatesFile = (...templates: ExcelImportTemplate[]): string => JSON.stringify({ templates }, null, 2)

/** 解析合并结果里的 accounts（write 才有效） */
function writtenAccounts(outcome: MergeOutcome): AccountEntry[] {
  if (outcome.kind !== 'write') throw new Error(`期望 write，实际 ${outcome.kind}`)
  return (JSON.parse(outcome.content) as { accounts: AccountEntry[] }).accounts
}

/**
 * 收敛性断言：交换 ours/theirs（= 两台机器各自拉取）后，
 * **最终文件内容**必须一致（或两侧同样报冲突）。
 *
 * 注意不能直接比较 outcome：机器 A 得 write(theirs)、机器 B 得 unchanged（本地已是对的）
 * ——kind 不同但落盘状态相同，这正是快速前进恒等的表现。
 */
function resulting(triple: FileTriple): { conflict: boolean; content: string | null } {
  const outcome = mergeForPath(triple)
  switch (outcome.kind) {
    case 'write': return { conflict: false, content: outcome.content }
    case 'delete': return { conflict: false, content: null }
    case 'unchanged': return { conflict: false, content: triple.ours }
    default: return { conflict: true, content: null }
  }
}

function expectSymmetric(triple: FileTriple): MergeOutcome {
  const a = mergeForPath(triple)
  const b = mergeForPath({ ...triple, ours: triple.theirs, theirs: triple.ours })
  expect(resulting(triple)).toEqual(resulting({ ...triple, ours: triple.theirs, theirs: triple.ours }))
  expect(a.kind === 'conflict').toBe(b.kind === 'conflict')
  return a
}

// ---- 三态外壳 ----

describe('mergeThreeWay（三态语义）', () => {
  const diverged = (o: string, b: string | null, t: string): MergeOutcome =>
    o === t ? { kind: 'unchanged' } : { kind: 'conflict' }

  const cases: Array<[string, string | null, string | null, string | null, MergeOutcome]> = [
    ['两侧一致 → unchanged', 'X', 'X', 'X', { kind: 'unchanged' }],
    ['两侧都是 null → unchanged', null, null, null, { kind: 'unchanged' }],
    ['仅本地改（base=theirs）→ unchanged', 'X', 'B', 'B', { kind: 'unchanged' }],
    ['仅远端改 → 写远端', 'B', 'B', 'X', { kind: 'write', content: 'X' }],
    ['仅远端删 → 删除', 'B', 'B', null, { kind: 'delete' }],
    ['远端新增（本地/基线都没有）→ 写远端', null, null, 'X', { kind: 'write', content: 'X' }],
    ['远端从未有 → unchanged', 'X', null, null, { kind: 'unchanged' }],
    ['本地删、远端改 → conflict', null, 'B', 'X', { kind: 'conflict' }],
    ['远端删、本地改 → conflict', 'X', 'B', null, { kind: 'conflict' }],
    ['两侧独立新增同一文件但内容不同 → diverged', 'A', null, 'B', { kind: 'conflict' }],
    ['三方各异 → diverged', 'A', 'B', 'C', { kind: 'conflict' }]
  ]

  for (const [title, ours, base, theirs, expected] of cases) {
    it(title, () => {
      expect(mergeThreeWay(ours, base, theirs, diverged)).toEqual(expected)
    })
  }
})

// ---- 账本文本 ----

describe('textDiverged（账本 diff3）', () => {
  const line = (n: number): string => `2026-01-0${n} * "a" "b"\n  Expenses:Food  1.00 CNY\n  Assets:Bank  -1.00 CNY\n`

  it('两侧改不同位置 → 干净合并（两边内容都保留）', () => {
    const base = line(1) + line(2) + line(3)
    const ours = line(1) + '2026-01-09 * "本地" "x"\n  Expenses:Food  9.00 CNY\n  Assets:Bank  -9.00 CNY\n' + line(3)
    const theirs = '2026-01-08 * "远端" "y"\n  Expenses:Food  8.00 CNY\n  Assets:Bank  -8.00 CNY\n' + line(1) + line(2) + line(3)
    const outcome = textDiverged(ours, base, theirs)
    expect(outcome.kind).toBe('write')
    const content = outcome.kind === 'write' ? outcome.content : ''
    expect(content).toContain('本地')
    expect(content).toContain('远端')
  })

  it('两侧改同一行 → conflict', () => {
    const base = line(1)
    const ours = base.replace('1.00', '2.00')
    const theirs = base.replace('1.00', '3.00')
    expect(textDiverged(ours, base, theirs)).toEqual({ kind: 'conflict' })
  })

  it('base 为 null（两端独立新增且不同）→ conflict', () => {
    expect(textDiverged(line(1), null, line(2))).toEqual({ kind: 'conflict' })
  })
})

// ---- 账户库结构化并集 ----

describe('mergeForPath（accounts.json 并集）', () => {
  const base = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '银行卡'))

  it('两侧各自新增不同账户 → 并集（无冲突）', () => {
    const ours = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '银行卡'), acct(3, 'Expenses:Rent', '房租'))
    const theirs = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '银行卡'), acct(3, 'Expenses:Fun', '娱乐'))
    const outcome = expectSymmetric({ path: ACCOUNTS, base, ours, theirs })
    const merged = writtenAccounts(outcome)
    // id 分配按 value 升序做确定性落位：两侧新条目的 prefId 都是 3 → 字典序靠前者得 3、后者顺延 4
    expect(merged.map((a) => a.value)).toEqual(['Expenses:Food', 'Assets:Bank', 'Expenses:Fun', 'Expenses:Rent'])
    expect(merged.map((a) => a.id)).toEqual([1, 2, 3, 4])
    expect(new Set(merged.map((a) => a.id)).size).toBe(4) // id 不重复
  })

  it('仅一侧改动 → 直接采用该侧（不重排 id）', () => {
    const ours = base
    const theirs = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '工资卡'))
    const outcome = mergeForPath({ path: ACCOUNTS, base, ours, theirs })
    expect(outcome).toEqual({ kind: 'write', content: theirs })
  })

  it('同一账户两侧改成不同内容 → conflict', () => {
    const ours = accountsFile(acct(1, 'Expenses:Food', '吃饭'), acct(2, 'Assets:Bank', '银行卡'))
    const theirs = accountsFile(acct(1, 'Expenses:Food', '餐饮支出'), acct(2, 'Assets:Bank', '银行卡'))
    expect(mergeForPath({ path: ACCOUNTS, base, ours, theirs })).toEqual({ kind: 'conflict' })
  })

  it('同一账户两侧改成相同内容 → 收敛为一条', () => {
    const ours = accountsFile(acct(1, 'Expenses:Food', '吃饭'), acct(2, 'Assets:Bank', '银行卡'))
    const theirs = accountsFile(acct(1, 'Expenses:Food', '吃饭'), acct(2, 'Assets:Bank', '银行卡'))
    expect(mergeForPath({ path: ACCOUNTS, base, ours, theirs })).toEqual({ kind: 'unchanged' })
  })

  it('一侧删除、另一侧未改 → 删除生效', () => {
    const onlyFood = accountsFile(acct(1, 'Expenses:Food', '餐饮'))
    // 远端删除 Bank、本地未动 → 落盘为远端的删除结果
    const remoteDeleted = mergeForPath({ path: ACCOUNTS, base, ours: base, theirs: onlyFood })
    expect(writtenAccounts(remoteDeleted).map((a) => a.id)).toEqual([1])
    // 本地删除、远端未动 → 本地内容已是正确结果（不写盘；提交时索引会记录删除）
    expect(mergeForPath({ path: ACCOUNTS, base, ours: onlyFood, theirs: base })).toEqual({ kind: 'unchanged' })
  })

  it('一侧删除、另一侧改过 → conflict', () => {
    const ours = accountsFile(acct(1, 'Expenses:Food', '餐饮'))
    const theirs = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '工资卡'))
    expect(mergeForPath({ path: ACCOUNTS, base, ours, theirs })).toEqual({ kind: 'conflict' })
  })

  it('enabled / counterparty 等可选字段在并集后保留', () => {
    const ours = accountsFile(acct(1, 'Expenses:Food', '餐饮', { enabled: false }), acct(2, 'Assets:Bank', '银行卡'))
    const theirs = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '银行卡', { counterparty: true }))
    // 两侧改的是不同条目 → 干净并集，两个标记都保留
    const merged = writtenAccounts(expectSymmetric({ path: ACCOUNTS, base, ours, theirs }))
    expect(merged.find((a) => a.value === 'Expenses:Food')?.enabled).toBe(false)
    expect(merged.find((a) => a.value === 'Assets:Bank')?.counterparty).toBe(true)
    // 同一条目两侧改成不同内容 → conflict
    const conflictOurs = accountsFile(acct(1, 'Expenses:Food', '餐饮', { enabled: false }), acct(2, 'Assets:Bank', '银行卡'))
    const conflictTheirs = accountsFile(acct(1, 'Expenses:Food', '餐饮', { enabled: true }), acct(2, 'Assets:Bank', '银行卡'))
    expect(mergeForPath({ path: ACCOUNTS, base, ours: conflictOurs, theirs: conflictTheirs })).toEqual({ kind: 'conflict' })
  })

  it('两端独立持有账户库（base=null，升级迁移场景）→ 纯并集', () => {
    const ours = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '银行卡'))
    const theirs = accountsFile(acct(1, 'Expenses:Rent', '房租'))
    const outcome = expectSymmetric({ path: ACCOUNTS, base: null, ours, theirs })
    const merged = writtenAccounts(outcome)
    expect(merged.map((a) => a.value).sort()).toEqual(['Assets:Bank', 'Expenses:Food', 'Expenses:Rent'])
    expect(new Set(merged.map((a) => a.id)).size).toBe(3)
  })

  it('文件损坏（非法 JSON / 非法条目）→ conflict', () => {
    const theirs = accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '工资卡'))
    expect(mergeForPath({ path: ACCOUNTS, base, ours: '{oops', theirs })).toEqual({ kind: 'conflict' })
    const bad = accountsFile(acct(1, 'expenses:food', '小写路径'))
    expect(mergeForPath({ path: ACCOUNTS, base, ours: bad, theirs })).toEqual({ kind: 'conflict' })
  })

  it('账户数超上限 → conflict', () => {
    const many = accountsFile(...Array.from({ length: 501 }, (_, i) => acct(i + 1, `Expenses:A${i}`)))
    expect(mergeForPath({ path: ACCOUNTS, base, ours: many, theirs: accountsFile(acct(9, 'Expenses:Z')) })).toEqual({ kind: 'conflict' })
  })
})

// ---- 收敛性属性 ----

describe('收敛性（两机各自合并同一组输入必须结果一致）', () => {
  const fixtures: Array<{ title: string; base: string | null; ours: string; theirs: string }> = [
    {
      title: '各加一个账户，本地 id 撞号',
      base: accountsFile(acct(1, 'Expenses:Food', '餐饮')),
      ours: accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Expenses:Rent', '房租')),
      theirs: accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Expenses:Fun', '娱乐'))
    },
    {
      title: 'base 为空，两侧各有不同账户',
      base: null,
      ours: accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '银行卡')),
      theirs: accountsFile(acct(1, 'Expenses:Rent', '房租'))
    },
    {
      title: '一侧改 name、另一侧改 description（不同条目）',
      base: accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '银行卡')),
      ours: accountsFile(acct(1, 'Expenses:Food', '吃饭'), acct(2, 'Assets:Bank', '银行卡')),
      theirs: accountsFile(acct(1, 'Expenses:Food', '餐饮'), acct(2, 'Assets:Bank', '储蓄卡'))
    }
  ]

  for (const f of fixtures) {
    it(f.title, () => {
      const outcome = expectSymmetric({ path: ACCOUNTS, base: f.base, ours: f.ours, theirs: f.theirs })
      expect(outcome.kind).toBe('write')
      const merged = outcome.kind === 'write' ? outcome.content : ''
      // 二次归并幂等：两台机器都拿到 merged 后再互相同步 → 不再产生差异
      expect(mergeForPath({ path: ACCOUNTS, base: f.base, ours: merged, theirs: merged })).toEqual({ kind: 'unchanged' })
      // 已合并内容再对未合并的远端 → 不倒退（结果或为 unchanged、或为同样的并集）
      expect(resulting({ path: ACCOUNTS, base: f.base, ours: merged, theirs: f.theirs }).conflict).toBe(false)
    })
  }

  it('快速前进恒等：base=ours → 逐字节采用 theirs', () => {
    const theirs = accountsFile(acct(7, 'Expenses:X', 'X'))
    expect(mergeForPath({ path: ACCOUNTS, base: theirs, ours: theirs, theirs })).toEqual({ kind: 'unchanged' })
    const base = accountsFile(acct(1, 'Expenses:Food', '餐饮'))
    const outcome = expectSymmetric({ path: ACCOUNTS, base, ours: base, theirs })
    expect(outcome).toEqual({ kind: 'write', content: accountsFile(acct(7, 'Expenses:X', 'X')) })
  })
})

// ---- Excel 模板 ----

describe('mergeForPath（Excel 模板并集，键 = source）', () => {
  it('两机各自新建同 source 模板（id 不同、内容相同）→ 收敛为一条', () => {
    const base = templatesFile()
    const ours = templatesFile(template('cmb', 'excel-aaa'))
    const theirs = templatesFile(template('cmb', 'excel-bbb'))
    const result = resulting({ path: TEMPLATES, base, ours, theirs })
    expectSymmetric({ path: TEMPLATES, base, ours, theirs })
    expect(result.conflict).toBe(false)
    const merged = JSON.parse(result.content ?? '{}') as { templates: ExcelImportTemplate[] }
    expect(merged.templates).toHaveLength(1)
    expect(merged.templates[0]?.source).toBe('cmb')
    // 两台机器落盘后得到同一个 id（min('excel-aaa','excel-bbb')），下次同步即 unchanged
    expect(merged.templates[0]?.id).toBe('excel-aaa')
  })

  it('同 source 两侧配置不同 → conflict', () => {
    const base = templatesFile()
    const ours = templatesFile(template('cmb', 'excel-aaa', '招商A'))
    const theirs = templatesFile(template('cmb', 'excel-bbb', '招商B'))
    expect(mergeForPath({ path: TEMPLATES, base, ours, theirs })).toEqual({ kind: 'conflict' })
  })

  it('不同 source 各自新增 → 并集', () => {
    const base = templatesFile()
    const ours = templatesFile(template('cmb', 'excel-aaa'))
    const theirs = templatesFile(template('alipay', 'excel-bbb'))
    const outcome = expectSymmetric({ path: TEMPLATES, base, ours, theirs })
    const merged = JSON.parse((outcome as { content: string }).content) as { templates: ExcelImportTemplate[] }
    expect(merged.templates.map((t) => t.source)).toEqual(['alipay', 'cmb'])
  })

  it('同一文件内同 source 重复条目 → 解析阶段收敛为一条', () => {
    const base = templatesFile()
    const ours = templatesFile(template('cmb', 'excel-aaa'), template('cmb', 'excel-bbb'))
    const theirs = templatesFile(template('cmb', 'excel-aaa'))
    const outcome = mergeForPath({ path: TEMPLATES, base, ours, theirs })
    const merged = JSON.parse((outcome as { content: string }).content) as { templates: ExcelImportTemplate[] }
    expect(merged.templates).toHaveLength(1)
  })

  it('新条目的 id 分配是纯函数 → 两侧交换后逐字节一致', () => {
    const ours = templatesFile(template('cmb', 'excel-x'))
    const theirs = templatesFile(template('cmb', 'excel-y'), template('alipay', 'excel-x'))
    const a = expectSymmetric({ path: TEMPLATES, base: templatesFile(), ours, theirs })
    const merged = JSON.parse((a as { content: string }).content) as { templates: ExcelImportTemplate[] }
    // 两侧各自持有一个 id 为 excel-x 的模板（不同 source）→ 字典序靠前者保留该 id、后者派生新 id
    expect(merged.templates.map((t) => t.source)).toEqual(['alipay', 'cmb'])
    expect(new Set(merged.templates.map((t) => t.id)).size).toBe(2)
  })
})

// ---- 计划与账本守卫 ----

describe('mergeTrackedFiles / mergeForPath 守卫', () => {
  it('账本文件不允许 delete → 降级为清空', () => {
    expect(mergeForPath({ path: LEDGER, base: 'x', ours: 'x', theirs: null })).toEqual({ kind: 'write', content: '' })
  })

  it('非 JSON 路径（.gitignore）按文本处理：改动位置不重叠 → 干净合并', () => {
    const base = 'a\n'
    const ours = 'a\nb\n' // 本地追加
    const theirs = 'x\na\n' // 远端前插
    expect(mergeForPath({ path: SYNC_GITIGNORE_FILE, base, ours, theirs })).toEqual({ kind: 'write', content: 'x\na\nb\n' })
  })

  it('非 JSON 路径（.gitignore）改动位置重叠 → conflict', () => {
    const base = 'a\n'
    expect(mergeForPath({ path: SYNC_GITIGNORE_FILE, base, ours: 'a\nb\n', theirs: 'a\nc\n' })).toEqual({ kind: 'conflict' })
  })

  it('计划汇总冲突文件并携带三路快照', () => {
    const plan = mergeTrackedFiles([
      { path: LEDGER, base: 'b', ours: 'b', theirs: 't' },
      { path: ACCOUNTS, base: accountsFile(acct(1, 'Expenses:Food', '餐饮')), ours: accountsFile(acct(1, 'Expenses:Food', '吃饭')), theirs: accountsFile(acct(1, 'Expenses:Food', '餐饮费')) }
    ])
    expect(plan.hasConflict).toBe(true)
    expect(plan.conflicts.map((c) => c.path)).toEqual([ACCOUNTS])
    expect(plan.conflicts[0]?.theirs).toContain('餐饮费')
    expect(plan.files[0]?.outcome).toEqual({ kind: 'write', content: 't' })
  })
})
