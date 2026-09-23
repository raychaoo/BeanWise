/**
 * 账内搬移（转账 / 信用卡还款 / 往来借出还款 / 权益调整）的用户可见口径 —— **口径单源**。
 *
 * 这类交易只有 `Assets:` / `Liabilities:` / `Equity:` 腿、没有损益腿（Income/Expenses），
 * 故只挪账户、只变债权债务，不产生损益、也不是收入或支出（见 main/core/index-builder.ts:342
 * 的「账内搬移」定义）。收支聚合只看损益腿（main/core/report-aggregation.ts:170-171），
 * 因此还款、借入都不会进「净结余 / 净利润」。
 *
 * 「同一口径写两遍，必有一处漏」（先例见 views/entries/AmountCell.tsx 头注释），故本口径收拢在此，
 * 报表「收支对比」卡底、利润表表头、现金流量表说明条、总览指标行下方一律 import，
 * 不要在视图里另写措辞。
 *
 * ⚠ 文案是 e2e 断言的输入：Playwright 的 getByText / hasText 都是**子串匹配 + strict mode**，
 * 文案里出现既有断言目标的子串（净资产趋势 / 收支对比 / 总资产 / 本月收支 / 账户余额 /
 * 收入小计 / 支出小计 / 资产合计 / 负债和所有者权益合计 / 校验通过：资产 = 负债 + 权益 …）
 * 会让命中数 +1 并报 strict violation。改文案前先跑 npm run test:e2e。
 */

/** 账内搬移不计收支（报表 / 总览各处的标准句） */
export const INTERNAL_TRANSFER_NOTE = '还款、借入等搬移不产生损益，不计入收支'

/** 净结余公式：报表「收支对比」卡底 + 总览指标行下方（两处都用「净结余」这个既有术语） */
export const NET_SURPLUS_FORMULA = '净结余 = 收入 − 支出'
