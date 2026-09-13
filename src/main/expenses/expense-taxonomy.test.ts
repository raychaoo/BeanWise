import { describe, expect, it } from 'vitest'
import {
  EXPENSE_ACCOUNT_RENAMES,
  EXPENSE_TAXONOMY,
  classifyExpense,
  flattenExpenseTaxonomy
} from './expense-taxonomy'

describe('expense taxonomy', () => {
  it('contains the complete author.md hierarchy with unique ASCII account paths', () => {
    const accounts = flattenExpenseTaxonomy()

    expect(accounts).toHaveLength(123)
    expect(new Set(accounts.map((a) => a.path)).size).toBe(accounts.length)
    expect(accounts.every((a) => /^Expenses:[A-Za-z0-9:]+$/.test(a.path))).toBe(true)
    expect(EXPENSE_TAXONOMY.map((node) => node.label)).toEqual([
      '生活消费',
      '居住',
      '住宿',
      '交通',
      '通讯',
      '数字服务',
      '娱乐',
      '购物',
      '旅游',
      '医疗健康',
      '教育学习',
      '社交人情',
      '金融费用',
      '税费',
      '其他支出'
    ])
  })

  it('keeps the old flat accounts mapped into the new hierarchy', () => {
    expect(EXPENSE_ACCOUNT_RENAMES).toMatchObject({
      'Expenses:Food': 'Expenses:Life:Food',
      'Expenses:Smoke': 'Expenses:Life:TobaccoAlcohol:Tobacco',
      'Expenses:Ai': 'Expenses:Digital:AI',
      'Expenses:Billing': 'Expenses:Digital:Software',
      'Expenses:Recreation': 'Expenses:Entertainment:Leisure',
      'Expenses:Shopping': 'Expenses:Shopping:Other',
      'Expenses:Uncategorized': 'Expenses:Other'
    })
  })
})

describe('classifyExpense', () => {
  it.each([
    ['麦当劳', '早餐', 'Expenses:Life:Food:Breakfast'],
    ['胖哆哆猪脚饭深圳富士嘉园店', '消费', 'Expenses:Life:Food'],
    ['美宜佳', '红玫王', 'Expenses:Life:TobaccoAlcohol:Tobacco'],
    ['粤华小卖部', '商品', 'Expenses:Life:Food'],
    ['小象生鲜', '水果', 'Expenses:Life:Food'],
    ['日海智能', '日海超市', 'Expenses:Life:Food'],
    ['茶油猪头肉观湖店', '快捷支付', 'Expenses:Life:Food'],
    ['UHOME有家', '快捷支付', 'Expenses:Life:Food'],
    ['名扬造型', '商品', 'Expenses:Life:PersonalCare:Haircut'],
    ['滴滴出行', '滴滴出行服务', 'Expenses:Transport:Taxi'],
    ['深圳市地铁相关运营主体', '深圳地铁', 'Expenses:Transport:PublicTransit:Metro'],
    ['中国铁路网络有限公司', '火车票', 'Expenses:Transport:PublicTransit:Train'],
    ['中国联通', '30元手机话费', 'Expenses:Communication:Mobile'],
    ['带宽网费', '带宽网费', 'Expenses:Communication:Broadband'],
    ['iCloud 由云上贵州运营', 'iCloud 由云上贵州运营', 'Expenses:Digital:Cloud'],
    ['杭州深度求索', 'DeepSeek API', 'Expenses:Digital:AI'],
    ['App Store _ Apple Music', 'Apple Music 订阅', 'Expenses:Entertainment:Music:Membership'],
    ['宜章县外星人电竞馆', '移动支付', 'Expenses:Entertainment:Leisure:InternetCafe'],
    ['京东商城平台商户', '京东订单', 'Expenses:Shopping:Other'],
    ['携程旅行网', '酒店预订', 'Expenses:Travel:Accommodation'],
    ['韶关市第一人民医院', '第一人民医院微信支付', 'Expenses:Health:Registration'],
    ['深圳市大像健身体育有限公司', '健身', 'Expenses:Health:Fitness'],
    ['微信红包', '微信红包', 'Expenses:Social:RedPacket'],
    ['微信转账', '转账备注:微信转账', 'Expenses:Other'],
    ['完全未知的商户', '完全未知的说明', 'Expenses:Other']
  ])('classifies %s / %s', (payee, narration, expected) => {
    expect(classifyExpense(payee, narration).account).toBe(expected)
  })

  it('reports confidence and a stable reason', () => {
    expect(classifyExpense('麦当劳', '早餐')).toMatchObject({
      account: 'Expenses:Life:Food:Breakfast',
      confidence: 'high',
      reason: 'food-meal'
    })
    expect(classifyExpense('完全未知的商户', '完全未知的说明')).toEqual({
      account: 'Expenses:Other',
      confidence: 'low',
      reason: 'fallback'
    })
  })
})
