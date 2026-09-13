import { describe, expect, it } from 'vitest'
import type { AccountEntry, AccountMappingConfig, ExcelImportTemplate } from '../../shared/ipc'
import { defaultAccountMapping } from './account-mapping'
import {
  applyTemplate,
  beanwiseMarker,
  decodeCsvBuffer,
  detectHeaderRow,
  detectNewAccounts,
  detectNewTypes,
  extractBeanwiseImportIds,
  suggestTypeAccount,
  fieldScore,
  parseCsv,
  resolveKind,
  suggestAccount,
  suggestFieldMapping,
  suggestTypeAccountWithMethod
} from './parser'
import { computeDedupFingerprint } from '../core/dedup'

const accountMapping = defaultAccountMapping()

function template(overrides: Partial<ExcelImportTemplate> = {}): ExcelImportTemplate {
  return {
    id: 't1',
    name: '测试模板',
    source: 'test-src',
    fieldMapping: {
      dateColumn: '交易时间',
      amountColumn: '金额',
      ioColumn: '收/支',
      typeColumn: '交易类型',
      counterpartyColumn: '交易对方',
      productColumn: '商品',
      methodColumn: '支付方式',
      rowIdColumn: '交易单号'
    },
    directionRule: { mode: 'column' },
    accountMapping,
    ...overrides
  }
}

const GRID = [
  ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
  ['2026-08-21 16:09:20', '商户消费', '麦当劳', '麦当劳', '17.4', '支出', '招商银行储蓄卡(8888)', 'A1'],
  ['2026-08-20 13:01:29', '转账', '杜永奇', '转账备注', '500', '收入', '零钱', 'B2'],
  ['2026-08-19 08:18:17', '零钱提现', '微信', '', '1000', '/', '招商银行储蓄卡(8888)', 'C3']
]

describe('parseCsv / decodeCsvBuffer', () => {
  it('基础 CSV 与引号内逗号/转义引号', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,"b,c"\n"say ""hi""",2\n')).toEqual([['a', 'b,c'], ['say "hi"', '2']])
  })

  it('UTF-8 / UTF-8 BOM / GBK 解码', () => {
    expect(decodeCsvBuffer(Buffer.from('a,b\n', 'utf8'))).toBe('a,b\n')
    expect(decodeCsvBuffer(Buffer.from('\uFEFFa,b\n', 'utf8'))).toBe('a,b\n')
    const gbk = Buffer.from([0xbd, 0xbb, 0xd2, 0xd7, 0xca, 0xb1, 0xbc, 0xe4, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0x32, 0x30, 0x32, 0x36, 0x2d, 0x30, 0x38, 0x2d, 0x32, 0x31, 0x2c, 0x31, 0x35, 0x0a])
    expect(decodeCsvBuffer(gbk)).toBe('交易时间,金额\n2026-08-21,15\n')
  })
})

describe('表头检测与列映射建议', () => {
  it('fieldScore 识别日期/金额列', () => {
    expect(fieldScore('交易时间', 'dateColumn')).toBeGreaterThan(0)
    expect(fieldScore('金额(元)', 'amountColumn')).toBeGreaterThan(0)
    expect(fieldScore('交易时间', 'amountColumn')).toBe(0)
  })

  it('detectHeaderRow 找到含日期+金额的表头行', () => {
    expect(detectHeaderRow([['随意', '数据'], GRID[0], GRID[1]])).toBe(1)
    expect(detectHeaderRow([['a', 'b'], ['c', 'd']])).toBe(-1)
  })

  it('suggestFieldMapping 唯一分配常见列', () => {
    const suggested = suggestFieldMapping(GRID[0])
    expect(suggested.dateColumn).toBe('交易时间')
    expect(suggested.amountColumn).toBe('金额')
    expect(suggested.ioColumn).toBe('收/支')
    expect(suggested.methodColumn).toBe('支付方式')
  })
})

describe('applyTemplate（列映射 + 方向 + 账户映射）', () => {
  it('column 模式：支出/收入/中性三行归一化，含账户与去重 id', () => {
    const rows = applyTemplate(GRID, template(), new Set())
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      date: '2026-08-21',
      time: '16:09:20',
      kind: 'expense',
      amount: '17.4',
      paymentMethod: '招商银行储蓄卡(8888)',
      rowId: 'A1',
      alreadyImported: false,
      expenseAccount: 'Expenses:Shopping',
      sourceAccount: 'Assets:WeChat' // 新支付方式未映射 → 兜底
    })
    expect(rows[1].kind).toBe('income')
    expect(rows[1].expenseAccount).toBe('Income:Transfer')
    expect(rows[1].sourceAccount).toBe('Assets:WeChat:Pay') // 支付方式=零钱 → 微信余额-资产
    expect(rows[2].kind).toBe('neutral')
  })

  it('支付方式零钱/余额映射到微信余额-资产/支付宝余额-资产', () => {
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2026-08-21 10:00:00', '商户消费', '商家', '商品', '20', '支出', '零钱', 'F1'],
      ['2026-08-21 11:00:00', '商户消费', '商家', '商品', '30', '支出', '余额', 'F2']
    ]
    const rows = applyTemplate(grid, template(), new Set())
    expect(rows[0].sourceAccount).toBe('Assets:WeChat:Pay')
    expect(rows[1].sourceAccount).toBe('Assets:Alipay:Balance')
  })

  it('支付方式未映射时按账户库智能匹配来源账户（招商银行→ZSYH），代发工资→工资收入', () => {
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2026-08-17 00:00:00', '代发工资', '深圳妙创信息技术有限公司', '工资', '10027.13', '收入', '招商银行', 'G1']
    ]
    const library = [
      { id: 1, name: '招商银行储蓄卡(6156)', value: 'Assets:Bank:ZSYH' },
      { id: 2, name: '建设银行储蓄卡(8396)', value: 'Assets:Bank:JSYH' }
    ]
    const rows = applyTemplate(grid, template(), new Set(), new Map(), library)
    expect(rows[0].sourceAccount).toBe('Assets:Bank:ZSYH')
    expect(rows[0].expenseAccount).toBe('Income:Salary')
  })

  it('交易类型为空但摘要含「代发工资/奖金」时归工资收入', () => {
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2026-08-17 00:00:00', '', '深圳妙创信息技术有限公司', '代发工资', '10027.13', '收入', '招商银行', 'G1'],
      ['2026-08-18 00:00:00', '', '某公司', '奖金', '5000', '收入', '招商银行', 'G2']
    ]
    const library = [{ id: 1, name: '招商银行储蓄卡(6156)', value: 'Assets:Bank:ZSYH' }]
    const rows = applyTemplate(grid, template(), new Set(), new Map(), library)
    expect(rows[0].expenseAccount).toBe('Income:Salary')
    expect(rows[1].expenseAccount).toBe('Income:Salary')
  })

  it('银联跨行代发：摘要含「代发工资」才归工资；余额宝赎回/提现不归工资', () => {
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2021-01-09 14:49:23', '银联跨行代发', '天弘基金管理有限公司', '银联入账(天弘基金管理有限公司/其它)余额宝赎回代付交易', '19', '收入', '交通银行', 'H1'],
      ['2021-01-12 16:24:07', '银联跨行代发', '国粤(韶关)电力有限公司', '代发工资 PAY02工资', '3000', '收入', '交通银行', 'H2']
    ]
    const library = [{ id: 1, name: '交通银行储蓄卡(3778)', value: 'Assets:Bank:JTYH' }]
    const rows = applyTemplate(grid, template(), new Set(), new Map(), library)
    expect(rows[0].expenseAccount).toBe('Income:Other') // 余额宝赎回不是工资
    expect(rows[1].expenseAccount).toBe('Income:Salary') // 摘要含代发工资 → 工资
  })

  it('退款冲减对应支出科目，而非计收入', () => {
    const config: AccountMappingConfig = {
      ...defaultAccountMapping(),
      expenseByType: { ...defaultAccountMapping().expenseByType, '美团平台商户-退款': 'Expenses:Shopping' }
    }
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2026-08-01 10:00:00', '美团平台商户-退款', '美团', '退款', '20', '收入', '零钱', 'R1']
    ]
    const library = [{ id: 1, name: '微信余额-资产', value: 'Assets:WeChat:Pay' }]
    const rows = applyTemplate(grid, { ...template(), accountMapping: config }, new Set(), new Map(), library)
    expect(rows[0].expenseAccount).toBe('Expenses:Shopping')
  })

  it('交易类型为空但摘要含「退款」时也冲减支出（未分类支出）', () => {
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2026-08-01 10:00:00', '', '支付宝（中国）网络技术有限公司', '网上支付退款交易流水号 2026...', '20', '收入', '交通银行', 'R2']
    ]
    const library = [{ id: 1, name: '交通银行储蓄卡(3778)', value: 'Assets:Bank:JTYH' }]
    const rows = applyTemplate(grid, template(), new Set(), new Map(), library)
    expect(rows[0].expenseAccount).toBe('Expenses:Uncategorized')
  })

  it('amountSign 模式：负数为支出、正数为收入', () => {
    const rows = applyTemplate(
      [
        ['日期', '金额', '对方'],
        ['2026-08-21', '-17.4', '麦当劳'],
        ['2026-08-22', '500', '工资']
      ],
      template({
        fieldMapping: { dateColumn: '日期', amountColumn: '金额', counterpartyColumn: '对方' },
        directionRule: { mode: 'amountSign', positiveAs: 'income' }
      }),
      new Set()
    )
    expect(rows[0].kind).toBe('expense')
    expect(rows[0].amount).toBe('17.4')
    expect(rows[1].kind).toBe('income')
  })

  it('keywords 模式：命中提现/充值为中性，否则默认支出', () => {
    const rows = applyTemplate(
      [
        ['日期', '金额', '类型'],
        ['2026-08-21', '1000', '零钱提现'],
        ['2026-08-22', '15', '商户消费']
      ],
      template({
        fieldMapping: { dateColumn: '日期', amountColumn: '金额', typeColumn: '类型' },
        directionRule: { mode: 'keywords', neutralKeywords: ['提现', '充值'], defaultKind: 'expense' }
      }),
      new Set()
    )
    expect(rows[0].kind).toBe('neutral')
    expect(rows[1].kind).toBe('expense')
  })

  it('已有去重标记 → alreadyImported', () => {
    const rows = applyTemplate(GRID, template(), new Set(['test-src:A1']))
    expect(rows[0].alreadyImported).toBe(true)
  })
  it('内容哈希 rowId 文件内重复时追加 #2/#3 保证唯一', () => {
    const grid = [
      ['交易时间', '金额', '交易对方', '收/支'],
      ['2026-08-21', '16.00', '渝香阁风味餐厅', '支出'],
      ['2026-08-21', '16.00', '渝香阁风味餐厅', '支出'],
      ['2026-08-21', '16.00', '渝香阁风味餐厅', '支出']
    ]
    const rows = applyTemplate(
      grid,
      template({ fieldMapping: { dateColumn: '交易时间', amountColumn: '金额', counterpartyColumn: '交易对方', ioColumn: '收/支' } }),
      new Set(),
      new Map()
    )
    const ids = rows.map((r) => r.rowId)
    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).not.toContain('#')
    expect(ids[1]).toBe(`${ids[0]}#2`)
    expect(ids[2]).toBe(`${ids[0]}#3`)
  })

  it('无单号列时 rowId 由字段 hash 生成且稳定', () => {
    const tpl = template({
      fieldMapping: { dateColumn: '交易时间', amountColumn: '金额', counterpartyColumn: '交易对方', typeColumn: '交易类型', ioColumn: '收/支' },
      directionRule: { mode: 'amountSign', positiveAs: 'expense' }
    })
    const grid = [
      ['交易时间', '交易类型', '交易对方', '金额', '收/支'],
      ['2026-08-21 16:09:20', '商户消费', '麦当劳', '17.4', '支出']
    ]
    const a = applyTemplate(grid, tpl, new Set())[0]
    const b = applyTemplate(grid, tpl, new Set())[0]
    expect(a.rowId).toBe(b.rowId)
    expect(a.rowId).toMatch(/^[a-f0-9]{16}$/)
  })

  it('非法日期/金额/方向抛中文行错误', () => {
    expect(() => applyTemplate(
      [['日期', '金额', '收/支'], ['bad-date', '1', '支出']],
      template({ fieldMapping: { dateColumn: '日期', amountColumn: '金额', ioColumn: '收/支' } }),
      new Set()
    )).toThrow(/交易时间格式非法/)
    expect(() => applyTemplate(
      [['日期', '金额', '收/支'], ['2026-08-21', 'abc', '支出']],
      template({ fieldMapping: { dateColumn: '日期', amountColumn: '金额', ioColumn: '收/支' } }),
      new Set()
    )).toThrow(/金额非法/)
    expect(() => applyTemplate(
      [['日期', '金额', '收/支'], ['2026-08-21', '1', '未知方向']],
      template({ fieldMapping: { dateColumn: '日期', amountColumn: '金额', ioColumn: '收/支' } }),
      new Set()
    )).toThrow(/方向无法识别/)
  })
})

describe('跨来源去重（dupState 三级判定）', () => {
  const fpA1 = computeDedupFingerprint('2026-08-21', '麦当劳', '17.4', 'expense')

  it('账本无同指纹 → none，且 fingerprint 与 dedup 计算一致', () => {
    const rows = applyTemplate(GRID, template(), new Set(), new Map())
    expect(rows[0]).toMatchObject({ dupState: 'none', fingerprint: fpA1 })
    expect(rows[1].dupState).toBe('none')
  })

  it('账本 1 笔同指纹 → suspect（疑似跨来源重复）', () => {
    const rows = applyTemplate(GRID, template(), new Set(), new Map([[fpA1, 1]]))
    expect(rows[0].dupState).toBe('suspect')
    expect(rows[1].dupState).toBe('none')
    expect(rows[2].dupState).toBe('none')
  })

  it('账本 ≥2 笔同指纹 → confirm（需人工确认，不自动跳）', () => {
    const rows = applyTemplate(GRID, template(), new Set(), new Map([[fpA1, 2]]))
    expect(rows[0].dupState).toBe('confirm')
  })

  it('文件内同指纹多笔 + 账本 1 笔 → confirm（避免误删真实交易）', () => {
    const row2 = [...GRID[1]]
    row2[7] = 'A2'
    const grid = [GRID[0], GRID[1], row2]
    const rows = applyTemplate(grid, template(), new Set(), new Map([[fpA1, 1]]))
    expect(rows[0].dupState).toBe('confirm')
    expect(rows[1].dupState).toBe('confirm')
  })

  it('同来源 rowId 命中 → exact 优先于指纹', () => {
    const rows = applyTemplate(GRID, template(), new Set(['test-src:A1']), new Map([[fpA1, 1]]))
    expect(rows[0]).toMatchObject({ alreadyImported: true, dupState: 'exact' })
  })
})

describe('detectNewAccounts（新交易账户检测）', () => {
  it('聚合未映射支付方式键并给账户库建议', () => {
    const rows = applyTemplate(GRID, template(), new Set())
    const library = [{ id: 1, name: '招商银行储蓄卡(6156)', value: 'Assets:Bank:CCB' }]
    const accounts = detectNewAccounts(rows, accountMapping, library)
    // 同支付方式按交易类型拆分为两条：支出 1 笔 + 提现 1 笔
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({
      id: '招商银行储蓄卡(8888)@零钱提现',
      key: '招商银行储蓄卡(8888)',
      type: '零钱提现',
      count: 1,
      amount: '1000',
      suggestedAccount: 'Assets:Bank:CCB',
      resolution: 'fallback'
    })
    expect(accounts[1]).toMatchObject({
      id: '招商银行储蓄卡(8888)@商户消费',
      key: '招商银行储蓄卡(8888)',
      type: '商户消费',
      count: 1,
      amount: '17.4',
      suggestedAccount: 'Assets:Bank:CCB',
      resolution: 'fallback'
    })
  })

  it('已映射键不出现；账户库无建议时 suggestedAccount 为空', () => {
    const rows = applyTemplate(GRID, template(), new Set())
    const withMapping = {
      ...accountMapping,
      sourceByMethod: { ...accountMapping.sourceByMethod, '招商银行储蓄卡(8888)': 'Assets:Bank:ICBC' },
      cashAccountByMethod: { ...accountMapping.cashAccountByMethod, '招商银行储蓄卡(8888)': 'Assets:Bank:ICBC' }
    }
    expect(detectNewAccounts(rows, withMapping, [])).toHaveLength(0)
    const noBank = detectNewAccounts(rows, accountMapping, [{ id: 1, name: '微信余额', value: 'Assets:WeChat' }])
    expect(noBank[0].suggestedAccount).toBe('')
  })
})


describe('suggestAccount（银行类键回退取最相近账户）', () => {
  const library = [
    { id: 1, name: '招商银行储蓄卡(6156)', value: 'Assets:Bank:ZSYH' },
    { id: 2, name: '建设银行储蓄卡(8396)', value: 'Assets:Bank:JSYH' },
    { id: 3, name: '交通银行储蓄卡(3378)', value: 'Assets:Bank:JTYH' }
  ]

  it('尾号不一致时命中同银行储蓄卡，而非列表首个银行账户', () => {
    expect(suggestAccount('交通银行储蓄卡(3778)', library)).toBe('Assets:Bank:JTYH')
  })

  it('带前缀的支付方式（云闪付-招商银行(6156)）按公共子串命中对应银行', () => {
    expect(suggestAccount('云闪付-招商银行(6156)', library)).toBe('Assets:Bank:ZSYH')
    expect(suggestAccount('交通银行信用卡(8781)', [
      ...library,
      { id: 9, name: '交通银行信用卡', value: 'Liabilities:CreditCard:JTYHXYK' }
    ])).toBe('Liabilities:CreditCard:JTYHXYK')
  })

  it('名称完全一致时精确命中', () => {
    expect(suggestAccount('交通银行储蓄卡(3378)', library)).toBe('Assets:Bank:JTYH')
  })

  it('非银行键且无精确匹配时返回空', () => {
    expect(suggestAccount('微信零钱', library)).toBe('')
  })

  it('钱包约定映射：零钱→微信余额、余额→支付宝余额、余额宝→余额宝', () => {
    const lib = [
      { id: 1, name: '微信余额-资产', value: 'Assets:WeChat:Pay' },
      { id: 2, name: '支付宝余额-资产', value: 'Assets:Alipay:Balance' },
      { id: 3, name: '余额宝', value: 'Assets:Alipay:YuEBao' }
    ]
    expect(suggestAccount('零钱', lib)).toBe('Assets:WeChat:Pay')
    expect(suggestAccount('余额', lib)).toBe('Assets:Alipay:Balance') // 不得被微信余额抢先
    expect(suggestAccount('余额宝', lib)).toBe('Assets:Alipay:YuEBao')
    expect(suggestAccount('余额&现金抵价券', lib)).toBe('Assets:Alipay:Balance') // 复合键按内含钱包词归位
    expect(suggestAccount('零钱&红包', lib)).toBe('Assets:WeChat:Pay')
  })
})
describe('suggestTypeAccountWithMethod（新交易类型建议跟随支付方式）', () => {
  const library: AccountEntry[] = [
    { id: 1, name: '招商银行储蓄卡(6156)', value: 'Assets:Bank:ZSYH' },
    { id: 2, name: '交通银行储蓄卡(3378)', value: 'Assets:Bank:JTYH' },
    { id: 3, name: '微信余额-资产', value: 'Assets:WeChat:Pay' },
    { id: 4, name: '支付宝余额-资产', value: 'Assets:Alipay:Balance' },
    { id: 5, name: '余额宝', value: 'Assets:Alipay:YuEBao' },
    { id: 6, name: '花呗', value: 'Liabilities:Alipay:Huabei' },
    { id: 7, name: '交通银行信用卡', value: 'Liabilities:CreditCard:JTYHXYK' }
  ]
  const config: AccountMappingConfig = {
    ...defaultAccountMapping(),
    expenseByType: { '商户消费@零钱': 'Assets:WeChat:Pay' },
    incomeByType: {},
    sourceByMethod: { 零钱: 'Assets:WeChat:Pay', 余额: 'Assets:Alipay:Balance' },
    cashAccountByMethod: { 零钱: 'Assets:WeChat:Pay', 余额: 'Assets:Alipay:Balance' }
  }

  it('全新银行类支付方式（尾号不一致）按账户库模糊命中同银行', () => {
    expect(suggestTypeAccountWithMethod('餐饮美食', 'expense', '交通银行储蓄卡(3778)', config, library)).toBe('Assets:Bank:JTYH')
    expect(suggestTypeAccountWithMethod('服饰装扮', 'expense', '交通银行信用卡(8781)', config, library)).toBe('Liabilities:CreditCard:JTYHXYK')
  })

  it('模板对该支付方式的既有映射为来源账户时跟随（通用模板惯例）', () => {
    expect(suggestTypeAccountWithMethod('商户消费', 'expense', '零钱', config, library)).toBe('Assets:WeChat:Pay')
  })

  it('钱包类支付方式（余额/余额宝）按对应资产账户建议', () => {
    expect(suggestTypeAccountWithMethod('餐饮美食', 'expense', '余额', config, library)).toBe('Assets:Alipay:Balance')
    expect(suggestTypeAccountWithMethod('充值缴费', 'expense', '余额宝', config, library)).toBe('Assets:Alipay:YuEBao')
    expect(suggestTypeAccountWithMethod('保险', 'expense', '花呗', config, library)).toBe('Liabilities:Alipay:Huabei')
  })

  it('支付方式无信号时回退交易类型关键词；空支付方式回退关键词', () => {
    expect(suggestTypeAccountWithMethod('手续费', 'expense', '未知渠道', config, library)).toBe('Expenses:Fee')
    expect(suggestTypeAccountWithMethod('手续费', 'expense', '', config, library)).toBe('Expenses:Fee')
  })
})

describe('detectNewTypes / suggestTypeAccount（新交易类型键，按实际导入数据）', () => {
  it('聚合未映射交易类型键（支出/收入分开），按关键词给建议账户', () => {
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2026-08-21 10:00:00', '手续费', '招商银行', '转账手续费', '30', '支出', '招商银行储蓄卡(8888)', 'D1'],
      ['2026-08-21 11:00:00', '退款', '美团', '退款', '20', '收入', '招商银行储蓄卡(8888)', 'D2'],
      ['2026-08-21 12:00:00', '理财收益', '基金公司', '赎回收益', '12.5', '收入', '招商银行储蓄卡(8888)', 'D3'],
      ['2026-08-21 13:00:00', '商户消费', '麦当劳', '麦当劳', '17.4', '支出', '招商银行储蓄卡(8888)', 'D4']
    ]
    const rows = applyTemplate(grid, template(), new Set())
    const types = detectNewTypes(rows, accountMapping)
    expect(types).toHaveLength(3)
    expect(types).toContainEqual(expect.objectContaining({ id: 'expense:手续费@招商银行储蓄卡(8888)', key: '手续费', method: '招商银行储蓄卡(8888)', kind: 'expense', count: 1, amount: '30', suggestedAccount: 'Expenses:Fee', resolution: 'fallback' }))
    expect(types).toContainEqual(expect.objectContaining({ id: 'income:退款@招商银行储蓄卡(8888)', key: '退款', method: '招商银行储蓄卡(8888)', kind: 'income', count: 1, amount: '20', suggestedAccount: 'Income:Refund' }))
    expect(types).toContainEqual(expect.objectContaining({ id: 'income:理财收益@招商银行储蓄卡(8888)', key: '理财收益', method: '招商银行储蓄卡(8888)', kind: 'income', count: 1, amount: '12.5', suggestedAccount: '' }))
  })

  it('已映射类型键与中性行不出现；同类型支出/收入各自独立成项', () => {
    const grid = [
      ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
      ['2026-08-21 10:00:00', '商户消费', '麦当劳', '麦当劳', '17.4', '支出', '招商银行储蓄卡(8888)', 'D1'],
      ['2026-08-21 11:00:00', '转账', '张三', '转账', '100', '支出', '零钱', 'D2'],
      ['2026-08-21 12:00:00', '转账', '李四', '转账', '200', '收入', '零钱', 'D3'],
      ['2026-08-21 13:00:00', '零钱提现', '微信', '', '1000', '/', '招商银行储蓄卡(8888)', 'D4']
    ]
    const rows = applyTemplate(grid, template(), new Set())
    const types = detectNewTypes(rows, accountMapping)
    // 商户消费已映射（expenseByType）；零钱提现中性不参与；转账支出已映射、转账收入已映射
    expect(types).toHaveLength(0)
    const stripped = { ...accountMapping, expenseByType: {}, incomeByType: {} }
    const types2 = detectNewTypes(rows, stripped)
    expect(types2).toContainEqual(expect.objectContaining({ id: 'expense:转账@零钱', key: '转账', method: '零钱', kind: 'expense', count: 1 }))
    expect(types2).toContainEqual(expect.objectContaining({ id: 'income:转账@零钱', key: '转账', method: '零钱', kind: 'income', count: 1 }))
    expect(types2.some((t) => t.key === '零钱提现')).toBe(false)
  })

  it('suggestTypeAccount 关键词启发式：命中/未命中/空键', () => {
    expect(suggestTypeAccount('还款', 'expense')).toBe('Expenses:Transfer')
    expect(suggestTypeAccount('利息', 'income')).toBe('Income:Interest')
    expect(suggestTypeAccount('转账', 'income')).toBe('')
    expect(suggestTypeAccount('', 'expense')).toBe('')
  })
})

describe('复合键：同类型按支付方式 / 同支付方式按类型拆分（M10）', () => {
  const grid = [
    ['交易时间', '交易类型', '交易对方', '商品', '金额', '收/支', '支付方式', '交易单号'],
    ['2026-08-21 10:00:00', '转账', '张三', '转账', '100', '支出', '零钱', 'E1'],
    ['2026-08-21 11:00:00', '转账', '李四', '转账', '200', '支出', '招商银行储蓄卡(8888)', 'E2'],
    ['2026-08-21 12:00:00', '转账', '王五', '转账', '300', '收入', '零钱', 'E3'],
    ['2026-08-21 13:00:00', '商户消费', '麦当劳', '麦当劳', '50', '支出', '零钱', 'E4'],
    ['2026-08-21 14:00:00', '商户消费', '肯德基', '肯德基', '60', '支出', '招商银行储蓄卡(8888)', 'E5']
  ]

  it('detectNewTypes：同「转账」按支付方式拆分为多条', () => {
    const rows = applyTemplate(grid, template(), new Set())
    const types = detectNewTypes(rows, { ...accountMapping, expenseByType: {}, incomeByType: {} })
    expect(types).toContainEqual(expect.objectContaining({ id: 'expense:转账@零钱', key: '转账', method: '零钱', kind: 'expense', count: 1, amount: '100' }))
    expect(types).toContainEqual(expect.objectContaining({ id: 'expense:转账@招商银行储蓄卡(8888)', key: '转账', method: '招商银行储蓄卡(8888)', kind: 'expense', count: 1, amount: '200' }))
    expect(types).toContainEqual(expect.objectContaining({ id: 'income:转账@零钱', key: '转账', method: '零钱', kind: 'income', count: 1, amount: '300' }))
  })

  it('detectNewAccounts：同支付方式按交易类型拆分为多条', () => {
    const rows = applyTemplate(grid, template(), new Set())
    const accounts = detectNewAccounts(rows, accountMapping, [])
    // 零钱 已映射（sourceByMethod['零钱']）不出现；招商银行储蓄卡(8888) 未映射 → 按交易类型拆分
    expect(accounts).toHaveLength(2)
    expect(accounts).toContainEqual(expect.objectContaining({ id: '招商银行储蓄卡(8888)@转账', key: '招商银行储蓄卡(8888)', type: '转账', count: 1, amount: '200' }))
    expect(accounts).toContainEqual(expect.objectContaining({ id: '招商银行储蓄卡(8888)@商户消费', key: '招商银行储蓄卡(8888)', type: '商户消费', count: 1, amount: '60' }))
  })

  it('resolveRowAccounts：复合键映射优先于单维度键', () => {
    const config: AccountMappingConfig = {
      ...accountMapping,
      expenseByType: { ...accountMapping.expenseByType, '转账@零钱': 'Expenses:TransferWechat', 转账: 'Expenses:Transfer' },
      sourceByMethod: { ...accountMapping.sourceByMethod, '零钱@转账': 'Assets:WeChatBalance' }
    }
    const rows = applyTemplate(grid, template({ accountMapping: config }), new Set())
    const expenseWechat = rows.find((r) => r.transactionType === '转账' && r.kind === 'expense' && r.paymentMethod === '零钱')
    expect(expenseWechat?.expenseAccount).toBe('Expenses:TransferWechat')
    expect(expenseWechat?.sourceAccount).toBe('Assets:WeChatBalance')
    const expenseBank = rows.find((r) => r.transactionType === '转账' && r.kind === 'expense' && r.paymentMethod === '招商银行储蓄卡(8888)')
    expect(expenseBank?.expenseAccount).toBe('Expenses:Transfer')
    expect(expenseBank?.sourceAccount).toBe(accountMapping.fallbackSourceAccount)
  })
})

describe('去重标记', () => {
  it('beanwiseMarker 与 extractBeanwiseImportIds 配对', () => {
    const content = '2026-08-21 * "a"\n  Expenses:F  1 CNY\n  Assets:C  -1 CNY\n; beanwise-import: test-src:A1\n'
    expect(beanwiseMarker('test-src', 'A1')).toBe('; beanwise-import: test-src:A1')
    expect([...extractBeanwiseImportIds(content)]).toEqual(['test-src:A1'])
    expect(extractBeanwiseImportIds('; wechat-pay-id: x\n; other: y').size).toBe(0)
  })
})

describe('resolveKind（方向判定）', () => {
  it('column：收/支/中性', () => {
    expect(resolveKind({ mode: 'column' }, '支出', false, '', '', 1)).toBe('expense')
    expect(resolveKind({ mode: 'column' }, '收入', false, '', '', 1)).toBe('income')
    expect(resolveKind({ mode: 'column' }, '/', false, '', '', 1)).toBe('neutral')
    expect(resolveKind({ mode: 'column' }, '中性', false, '', '', 1)).toBe('neutral')
    expect(resolveKind({ mode: 'column' }, '中性交易', false, '', '', 1)).toBe('neutral')
    expect(resolveKind({ mode: 'column' }, '不计收支', false, '', '', 1)).toBe('neutral')
    expect(resolveKind({ mode: 'column' }, '不计入收支', false, '', '', 1)).toBe('neutral')
    expect(resolveKind({ mode: 'column' }, '不计', false, '', '', 1)).toBe('neutral')
    expect(resolveKind({ mode: 'column' }, 'C', false, '', '', 1)).toBe('income')
    expect(resolveKind({ mode: 'column' }, 'D', false, '', '', 1)).toBe('expense')
    expect(resolveKind({ mode: 'column' }, '贷', false, '', '', 1)).toBe('income')
    expect(resolveKind({ mode: 'column' }, '借', false, '', '', 1)).toBe('expense')
    expect(resolveKind({ mode: 'column' }, '退款', false, '', '', 1)).toBe('income')
    expect(() => resolveKind({ mode: 'column' }, '未知', false, '', '', 1)).toThrow()
  })
  it('类型文本含明确收支关键词时推断方向（代发工资→收入、消费→支出）', () => {
    expect(resolveKind({ mode: 'column' }, '代发工资', false, '', '', 1)).toBe('income')
    expect(resolveKind({ mode: 'keywords', neutralKeywords: [], defaultKind: 'expense' }, '', false, '代发工资', '', 1)).toBe('income')
    expect(resolveKind({ mode: 'keywords', neutralKeywords: [], defaultKind: 'expense' }, '', false, '银联无卡自助消费', '', 1)).toBe('expense')
    // 歧义词（朝朝宝转入）不推断，走默认
    expect(resolveKind({ mode: 'keywords', neutralKeywords: [], defaultKind: 'expense' }, '', false, '朝朝宝转入', '', 1)).toBe('expense')
    // 金额正负优先，不受类型推断影响
    expect(resolveKind({ mode: 'amountSign', positiveAs: 'income' }, '', true, '代发工资', '', 1)).toBe('expense')
  })
})
