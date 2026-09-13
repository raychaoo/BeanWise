export interface ExpenseTaxonomyNode {
  segment: string
  label: string
  children?: readonly ExpenseTaxonomyNode[]
}

export interface ExpenseAccountDefinition {
  path: string
  label: string
  parent: string | null
  leaf: boolean
}

export type ExpenseClassificationConfidence = 'high' | 'medium' | 'low'

export interface ExpenseClassification {
  account: string
  confidence: ExpenseClassificationConfidence
  reason: string
}

function node(
  segment: string,
  label: string,
  children?: readonly ExpenseTaxonomyNode[]
): ExpenseTaxonomyNode {
  return { segment, label, children }
}

/** author.md 中文树对应的 ASCII 账户树。Beancount v3 不接受中文账户名。 */
export const EXPENSE_TAXONOMY: readonly ExpenseTaxonomyNode[] = [
  node('Life', '生活消费', [
    node('Food', '餐饮', [
      node('Breakfast', '早餐'),
      node('Lunch', '午餐'),
      node('Dinner', '晚餐'),
      node('LateNight', '宵夜'),
      node('Snacks', '零食'),
      node('Drinks', '饮品'),
      node('Other', '其他')
    ]),
    node('Household', '日用品', [
      node('Cleaning', '清洁用品'),
      node('Home', '家居用品'),
      node('Other', '其他')
    ]),
    node('PersonalCare', '个人护理', [
      node('Haircut', '理发'),
      node('Skincare', '护肤'),
      node('Other', '其他')
    ]),
    node('Clothing', '服饰', [
      node('Clothes', '衣服、裤子'),
      node('Shoes', '鞋'),
      node('Accessories', '饰品'),
      node('Other', '其他')
    ]),
    node('TobaccoAlcohol', '烟酒槟榔', [
      node('Tobacco', '烟'),
      node('Alcohol', '酒'),
      node('BetelNut', '槟榔'),
      node('Other', '其他')
    ]),
    node('Other', '其他')
  ]),
  node('Housing', '居住', [
    node('Rent', '房租'),
    node('Water', '水费'),
    node('Electricity', '电费'),
    node('Gas', '燃气'),
    node('Property', '物业'),
    node('Repair', '家居维修'),
    node('Other', '其他')
  ]),
  node('Accommodation', '住宿'),
  node('Transport', '交通', [
    node('PublicTransit', '公共交通', [
      node('Metro', '地铁'),
      node('Bus', '公交'),
      node('Train', '火车、高铁'),
      node('Other', '其他')
    ]),
    node('Taxi', '打车'),
    node('Rideshare', '顺风车'),
    node('CarRental', '租车'),
    node('Driving', '自驾', [
      node('Fuel', '加油'),
      node('Parking', '停车'),
      node('Toll', '过路费'),
      node('Maintenance', '维修保养'),
      node('Insurance', '保险'),
      node('Other', '其他')
    ]),
    node('Other', '其他')
  ]),
  node('Communication', '通讯', [
    node('Mobile', '手机话费'),
    node('Broadband', '宽带'),
    node('Other', '其他')
  ]),
  node('Digital', '数字服务', [
    node('AI', 'AI工具'),
    node('Software', '软件订阅'),
    node('Cloud', '云服务'),
    node('Other', '其他')
  ]),
  node('Entertainment', '娱乐', [
    node('Games', '游戏', [
      node('Purchase', '游戏购买'),
      node('Recharge', '游戏充值'),
      node('Other', '其他')
    ]),
    node('Video', '影视', [
      node('Movie', '电影'),
      node('VideoMembership', '视频会员'),
      node('Other', '其他')
    ]),
    node('Music', '音乐', [
      node('Purchase', '音乐购买'),
      node('Membership', '音乐会员'),
      node('Other', '其他')
    ]),
    node('Performance', '演出'),
    node('Leisure', '休闲玩乐', [
      node('InternetCafe', '网吧'),
      node('BoardGames', '棋牌'),
      node('EventTicket', '赛事门票'),
      node('KTV', 'KTV'),
      node('Other', '其他')
    ]),
    node('Hobbies', '兴趣爱好', [
      node('Cycling', '公路车'),
      node('Basketball', '篮球'),
      node('Hiking', '徒步'),
      node('Other', '其他')
    ]),
    node('Other', '其他')
  ]),
  node('Shopping', '购物', [
    node('Computer', '电脑'),
    node('Phone', '手机'),
    node('Appliance', '家电'),
    node('Furniture', '家具'),
    node('Gift', '礼品'),
    node('Other', '其他')
  ]),
  node('Travel', '旅游', [
    node('Transport', '交通'),
    node('Accommodation', '住宿'),
    node('Food', '餐饮'),
    node('Ticket', '门票'),
    node('Shopping', '购物'),
    node('Other', '其他')
  ]),
  node('Health', '医疗健康', [
    node('Registration', '挂号'),
    node('Medicine', '医药'),
    node('Checkup', '体检'),
    node('Dental', '牙科'),
    node('EyeCare', '眼科'),
    node('Fitness', '健身'),
    node('Other', '其他')
  ]),
  node('Education', '教育学习', [
    node('Books', '书籍'),
    node('Courses', '课程'),
    node('Training', '培训'),
    node('Exams', '考试'),
    node('Other', '其他')
  ]),
  node('Social', '社交人情', [
    node('Treat', '请客'),
    node('RedPacket', '红包'),
    node('Dining', '聚餐'),
    node('Other', '其他')
  ]),
  node('Financial', '金融费用', [
    node('Fee', '手续费'),
    node('Interest', '利息'),
    node('FXLoss', '汇率损失'),
    node('Other', '其他')
  ]),
  node('Tax', '税费', [
    node('IncomeTax', '个人所得税'),
    node('Vehicle', '车辆相关'),
    node('Other', '其他')
  ]),
  node('Other', '其他支出')
]

export function flattenExpenseTaxonomy(): ExpenseAccountDefinition[] {
  const out: ExpenseAccountDefinition[] = []
  const walk = (nodes: readonly ExpenseTaxonomyNode[], parent: string | null): void => {
    for (const child of nodes) {
      const path = parent ? `${parent}:${child.segment}` : `Expenses:${child.segment}`
      out.push({
        path,
        label: child.label,
        parent,
        leaf: !child.children || child.children.length === 0
      })
      if (child.children) walk(child.children, path)
    }
  }
  walk(EXPENSE_TAXONOMY, null)
  return out
}

export const EXPENSE_ACCOUNT_RENAMES: Readonly<Record<string, string>> = {
  'Expenses:Food': 'Expenses:Life:Food:Other',
  'Expenses:Life:Food': 'Expenses:Life:Food:Other',
  'Expenses:Smoke': 'Expenses:Life:TobaccoAlcohol:Tobacco',
  'Expenses:Ai': 'Expenses:Digital:AI',
  'Expenses:Billing': 'Expenses:Digital:Software',
  'Expenses:Recreation': 'Expenses:Entertainment:Leisure:Other',
  'Expenses:Entertainment:Leisure': 'Expenses:Entertainment:Leisure:Other',
  'Expenses:NetworkFee': 'Expenses:Communication:Other',
  'Expenses:Shopping': 'Expenses:Shopping:Other',
  'Expenses:Uncategorized': 'Expenses:Other'
}

interface ExpenseRule {
  reason: string
  account: string
  confidence: ExpenseClassificationConfidence
  patterns: readonly RegExp[]
}

const RULES: readonly ExpenseRule[] = [
  {
    reason: 'food-meal',
    account: 'Expenses:Life:Food:Breakfast',
    confidence: 'high',
    patterns: [/早餐/]
  },
  {
    reason: 'food-meal',
    account: 'Expenses:Life:Food:Lunch',
    confidence: 'high',
    patterns: [/午餐|午饭|中餐/]
  },
  {
    reason: 'food-meal',
    account: 'Expenses:Life:Food:Dinner',
    confidence: 'high',
    patterns: [/晚餐|晚饭/]
  },
  {
    reason: 'food-meal',
    account: 'Expenses:Life:Food:LateNight',
    confidence: 'high',
    patterns: [/宵夜|夜宵/]
  },
  {
    reason: 'tobacco',
    account: 'Expenses:Life:TobaccoAlcohol:Tobacco',
    confidence: 'high',
    patterns: [/红玫王|芙蓉王|香烟|烟草|买烟|烟软|烟硬盒|烟\b|槟榔/]
  },
  {
    reason: 'alcohol',
    account: 'Expenses:Life:TobaccoAlcohol:Alcohol',
    confidence: 'high',
    patterns: [/白酒|啤酒|红酒|酒水|买酒|酒类/]
  },
  {
    reason: 'drinks',
    account: 'Expenses:Life:Food:Drinks',
    confidence: 'high',
    patterns: [/奶茶|咖啡|coffee|luckin|瑞幸|喜茶|奈雪|饮品|可乐|矿泉水|纯净水|桶装水|水店/]
  },
  {
    reason: 'snacks',
    account: 'Expenses:Life:Food:Snacks',
    confidence: 'high',
    patterns: [/零食|小吃|良品铺子|五号零食/]
  },
  {
    reason: 'personal-care-haircut',
    account: 'Expenses:Life:PersonalCare:Haircut',
    confidence: 'high',
    patterns: [/理发|美发|造型|剪发/]
  },
  {
    reason: 'food',
    account: 'Expenses:Life:Food:Other',
    confidence: 'high',
    patterns: [
      /麦当劳|金拱门|肯德基|kfc|汉堡|披萨|餐厅|餐饮|饭店|食府|美食|快餐|简餐|外卖/,
      /猪脚饭|肠粉|烧腊|牛肉面|拉面|饺子|馄饨|汤包|汤粉|包子|面粉店|面店/,
      /火锅|麻辣烫|麻辣拌|炸串|烤串|烧烤|沙县|黄焖鸡|鸡公煲|杨国福|酸菜鱼|酸菜|小面/,
      /鱼粉|烧鸭|猪头肉|鸡煲|明香鹅|饺饺者|四季稻香|渝面王|老陕西面馆|蒙自源|烤鱼|三津汤包/,
      /美团|饿了吗|饿了么|大众点评|点餐|日海智能|日海超市|小象生鲜|生鲜|百果园/,
      /便利店|小卖部|超市|生活超市|百货商店|乐购|美宜佳|起刻|柒荟|想家便利店|天福便利店|有家/
    ]
  },
  {
    reason: 'transport-metro',
    account: 'Expenses:Transport:PublicTransit:Metro',
    confidence: 'high',
    patterns: [/地铁|有轨电车|深圳通/]
  },
  {
    reason: 'transport-bus',
    account: 'Expenses:Transport:PublicTransit:Bus',
    confidence: 'high',
    patterns: [/公交|公共汽车|巴士/]
  },
  {
    reason: 'transport-train',
    account: 'Expenses:Transport:PublicTransit:Train',
    confidence: 'high',
    patterns: [/火车|高铁|铁路|中铁网络|智行/]
  },
  {
    reason: 'transport-taxi',
    account: 'Expenses:Transport:Taxi',
    confidence: 'high',
    patterns: [/滴滴|小拉出行|货拉拉|哈啰出行|哈啰|青奇|街兔|助力车|网约车|出租车/]
  },
  {
    reason: 'transport-fuel',
    account: 'Expenses:Transport:Driving:Fuel',
    confidence: 'high',
    patterns: [/加油|中国石化|中国石油|中石化|中石油/]
  },
  {
    reason: 'transport-parking',
    account: 'Expenses:Transport:Driving:Parking',
    confidence: 'high',
    patterns: [/停车费|停车/]
  },
  {
    reason: 'transport-toll',
    account: 'Expenses:Transport:Driving:Toll',
    confidence: 'high',
    patterns: [/过路费|高速通行|高速费/]
  },
  {
    reason: 'communication-mobile',
    account: 'Expenses:Communication:Mobile',
    confidence: 'high',
    patterns: [/手机话费|话费|中国移动|中国联通|中国电信|手机充值|充值服务/]
  },
  {
    reason: 'communication-broadband',
    account: 'Expenses:Communication:Broadband',
    confidence: 'high',
    patterns: [/宽带|带宽网费|网费/]
  },
  {
    reason: 'digital-ai',
    account: 'Expenses:Digital:AI',
    confidence: 'high',
    patterns: [/deepseek|深度求索|openai|chatgpt|claude|anthropic|ai工具|人工智能/]
  },
  {
    reason: 'digital-cloud',
    account: 'Expenses:Digital:Cloud',
    confidence: 'high',
    patterns: [/icloud|云上贵州|云上艾珀|云服务|阿里云|腾讯云|百度网盘/]
  },
  {
    reason: 'music-membership',
    account: 'Expenses:Entertainment:Music:Membership',
    confidence: 'high',
    patterns: [/apple\s*music|音乐会员|qq音乐|网易云音乐|酷狗音乐/]
  },
  {
    reason: 'music-purchase',
    account: 'Expenses:Entertainment:Music:Purchase',
    confidence: 'high',
    patterns: [/音乐购买|购买音乐|数字专辑/]
  },
  {
    reason: 'video-membership',
    account: 'Expenses:Entertainment:Video:VideoMembership',
    confidence: 'high',
    patterns: [/视频会员|腾讯视频|爱奇艺|优酷|芒果tv|哔哩哔哩|bilibili/]
  },
  {
    reason: 'video-movie',
    account: 'Expenses:Entertainment:Video:Movie',
    confidence: 'high',
    patterns: [/电影票|影城|电影院|电影/]
  },
  {
    reason: 'game-recharge',
    account: 'Expenses:Entertainment:Games:Recharge',
    confidence: 'high',
    patterns: [/游戏充值|游戏点券|点券充值/]
  },
  {
    reason: 'game-purchase',
    account: 'Expenses:Entertainment:Games:Purchase',
    confidence: 'high',
    patterns: [/游戏购买|购买游戏|steam|游戏/]
  },
  {
    reason: 'leisure-internet-cafe',
    account: 'Expenses:Entertainment:Leisure:InternetCafe',
    confidence: 'high',
    patterns: [/网咖|网吧|电竞馆|电竞/]
  },
  {
    reason: 'leisure-ktv',
    account: 'Expenses:Entertainment:Leisure:KTV',
    confidence: 'high',
    patterns: [/ktv|歌厅/]
  },
  {
    reason: 'leisure',
    account: 'Expenses:Entertainment:Leisure:Other',
    confidence: 'medium',
    patterns: [/棋牌|赛事门票|休闲娱乐|休闲玩乐|台球|密室|剧本杀/]
  },
  {
    reason: 'hobby-cycling',
    account: 'Expenses:Entertainment:Hobbies:Cycling',
    confidence: 'high',
    patterns: [/公路车|自行车|骑行/]
  },
  {
    reason: 'hobby-basketball',
    account: 'Expenses:Entertainment:Hobbies:Basketball',
    confidence: 'high',
    patterns: [/篮球/]
  },
  {
    reason: 'hobby-hiking',
    account: 'Expenses:Entertainment:Hobbies:Hiking',
    confidence: 'high',
    patterns: [/徒步|登山/]
  },
  {
    reason: 'shopping-computer',
    account: 'Expenses:Shopping:Computer',
    confidence: 'high',
    patterns: [/电脑|笔记本|显示器|键盘|鼠标|硬盘|内存条|dp1\.4|传输线/]
  },
  {
    reason: 'shopping-phone',
    account: 'Expenses:Shopping:Phone',
    confidence: 'high',
    patterns: [/手机购买|买手机|智能手机/]
  },
  {
    reason: 'shopping-appliance',
    account: 'Expenses:Shopping:Appliance',
    confidence: 'high',
    patterns: [/家电|冰箱|洗衣机|空调|电饭煲|微波炉/]
  },
  {
    reason: 'shopping-furniture',
    account: 'Expenses:Shopping:Furniture',
    confidence: 'high',
    patterns: [/家具|书桌|餐桌|沙发|床垫|床架|桌垫/]
  },
  {
    reason: 'shopping-gift',
    account: 'Expenses:Shopping:Gift',
    confidence: 'high',
    patterns: [/礼品|礼物/]
  },
  {
    reason: 'shopping',
    account: 'Expenses:Shopping:Other',
    confidence: 'high',
    patterns: [/京东|拼多多|淘宝|天猫|唯品会|转转|网购|商城|旗舰店|服饰|外套|卫衣|裤子|鞋/]
  },
  {
    reason: 'travel-accommodation',
    account: 'Expenses:Travel:Accommodation',
    confidence: 'high',
    patterns: [/携程|酒店|民宿|旅馆|住宿预订/]
  },
  {
    reason: 'travel-ticket',
    account: 'Expenses:Travel:Ticket',
    confidence: 'high',
    patterns: [/景区门票|景点门票|门票预订|旅游门票/]
  },
  {
    reason: 'health-registration',
    account: 'Expenses:Health:Registration',
    confidence: 'high',
    patterns: [/医院|挂号|门诊|诊所/]
  },
  {
    reason: 'health-medicine',
    account: 'Expenses:Health:Medicine',
    confidence: 'high',
    patterns: [/药店|医药|药房|买药/]
  },
  {
    reason: 'health-checkup',
    account: 'Expenses:Health:Checkup',
    confidence: 'high',
    patterns: [/体检/]
  },
  {
    reason: 'health-dental',
    account: 'Expenses:Health:Dental',
    confidence: 'high',
    patterns: [/牙科|口腔|洗牙|补牙/]
  },
  {
    reason: 'health-eye',
    account: 'Expenses:Health:EyeCare',
    confidence: 'high',
    patterns: [/眼科|眼镜|配镜/]
  },
  {
    reason: 'health-fitness',
    account: 'Expenses:Health:Fitness',
    confidence: 'high',
    patterns: [/健身|健身房|瑜伽|游泳馆/]
  },
  {
    reason: 'education-books',
    account: 'Expenses:Education:Books',
    confidence: 'high',
    patterns: [/书店|图书|书籍|买书/]
  },
  {
    reason: 'education-courses',
    account: 'Expenses:Education:Courses',
    confidence: 'high',
    patterns: [/网课|课程|在线课程/]
  },
  {
    reason: 'education-training',
    account: 'Expenses:Education:Training',
    confidence: 'high',
    patterns: [/培训|学费|教育/]
  },
  {
    reason: 'education-exams',
    account: 'Expenses:Education:Exams',
    confidence: 'high',
    patterns: [/考试|报名费|考证/]
  },
  {
    reason: 'housing-rent',
    account: 'Expenses:Housing:Rent',
    confidence: 'high',
    patterns: [/房租|租金|租房/]
  },
  {
    reason: 'housing-water',
    account: 'Expenses:Housing:Water',
    confidence: 'high',
    patterns: [/水费/]
  },
  {
    reason: 'housing-electricity',
    account: 'Expenses:Housing:Electricity',
    confidence: 'high',
    patterns: [/电费|电力缴费/]
  },
  {
    reason: 'housing-gas',
    account: 'Expenses:Housing:Gas',
    confidence: 'high',
    patterns: [/燃气费|天然气|煤气费/]
  },
  {
    reason: 'housing-property',
    account: 'Expenses:Housing:Property',
    confidence: 'high',
    patterns: [/物业费|物业管理/]
  },
  {
    reason: 'housing-repair',
    account: 'Expenses:Housing:Repair',
    confidence: 'high',
    patterns: [/家居维修|家电维修|维修保养|维修/]
  },
  {
    reason: 'social-red-packet',
    account: 'Expenses:Social:RedPacket',
    confidence: 'high',
    patterns: [/红包/]
  },
  {
    reason: 'social-treat',
    account: 'Expenses:Social:Treat',
    confidence: 'high',
    patterns: [/请客|请吃饭/]
  },
  {
    reason: 'social-dining',
    account: 'Expenses:Social:Dining',
    confidence: 'high',
    patterns: [/聚餐|聚会/]
  },
  {
    reason: 'financial-fee',
    account: 'Expenses:Financial:Fee',
    confidence: 'high',
    patterns: [/手续费|服务费|管理费|年费|利息罚息|逾期费/]
  },
  {
    reason: 'financial-interest',
    account: 'Expenses:Financial:Interest',
    confidence: 'high',
    patterns: [/利息支出|贷款利息|借款利息/]
  },
  {
    reason: 'financial-fx-loss',
    account: 'Expenses:Financial:FXLoss',
    confidence: 'high',
    patterns: [/汇率损失|汇兑损失/]
  },
  {
    reason: 'tax-income',
    account: 'Expenses:Tax:IncomeTax',
    confidence: 'high',
    patterns: [/个人所得税|个税/]
  },
  {
    reason: 'tax-vehicle',
    account: 'Expenses:Tax:Vehicle',
    confidence: 'high',
    patterns: [/车辆购置税|车船税|车辆相关税费/]
  },
  {
    reason: 'digital-software',
    account: 'Expenses:Digital:Software',
    confidence: 'medium',
    patterns: [/app\s*store|应用商店|软件订阅|订阅|会员服务|迅雷|腾讯计算机|度友科技|云上贵州/]
  },
  {
    reason: 'financial-other',
    account: 'Expenses:Financial:Other',
    confidence: 'medium',
    patterns: [/基金销售|小金库转入|基金买入|理财买入/]
  }
]

function normalizeExpenseText(payee: string, narration: string): string {
  return `${payee} ${narration}`
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）[\]【】_\-·]/g, '')
}

export function classifyExpense(payee: string, narration: string): ExpenseClassification {
  const text = normalizeExpenseText(payee, narration)
  if (!text) return { account: 'Expenses:Other', confidence: 'low', reason: 'fallback' }

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { account: rule.account, confidence: rule.confidence, reason: rule.reason }
    }
  }

  return { account: 'Expenses:Other', confidence: 'low', reason: 'fallback' }
}
