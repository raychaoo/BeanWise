/**
 * 十进制字符串金额运算（M4 定稿：渲染端自动平衡 + 主进程余额校验共用）。
 * 一律字符串逐位运算，禁止 parseFloat / Number —— 二进制浮点无法精确表示十进制小数
 * （0.1 + 0.2 !== 0.3）。输入/输出为规范化十进制字符串 ^-?\d+(\.\d+)?$：
 * 无前导零、无尾随零、无 -0。
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

function assertDecimal(s: string): void {
  if (typeof s !== 'string' || !DECIMAL_RE.test(s)) {
    throw new Error(`非法金额字符串: ${JSON.stringify(s)}`)
  }
}

/** 拆符号后的数字主体（无符号、含小数位） */
function body(s: string): string {
  return s.startsWith('-') ? s.slice(1) : s
}

function intPart(s: string): string {
  const b = body(s)
  const dot = b.indexOf('.')
  return dot === -1 ? b : b.slice(0, dot)
}

function fracPart(s: string): string {
  const b = body(s)
  const dot = b.indexOf('.')
  return dot === -1 ? '' : b.slice(dot + 1)
}

/** 非负整数串加法（右对齐逐位）；结果无前导零 */
function addMagnitude(a: string, b: string): string {
  let carry = 0
  let out = ''
  let i = a.length - 1
  let j = b.length - 1
  for (; i >= 0 || j >= 0 || carry > 0; i--, j--) {
    const sum = (i >= 0 ? a.charCodeAt(i) - 48 : 0) + (j >= 0 ? b.charCodeAt(j) - 48 : 0) + carry
    out = String(sum % 10) + out
    carry = sum >= 10 ? 1 : 0
  }
  return out
}

/** 非负整数串减法：a - b（要求 a >= b）；结果无前导零 */
function subMagnitude(a: string, b: string): string {
  let borrow = 0
  let out = ''
  let i = a.length - 1
  let j = b.length - 1
  for (; i >= 0; i--, j--) {
    let digit = (a.charCodeAt(i) - 48) - (j >= 0 ? b.charCodeAt(j) - 48 : 0) - borrow
    if (digit < 0) {
      digit += 10
      borrow = 1
    } else {
      borrow = 0
    }
    out = String(digit) + out
  }
  const trimmed = out.replace(/^0+(?=\d)/, '')
  return trimmed || '0'
}

/** 非负整数串比较：> 0 / < 0 / === 0（等长比字典序；长度差即值差） */
export function compareMagnitude(a: string, b: string): number {
  if (a.length !== b.length) return a.length > b.length ? 1 : -1
  return a === b ? 0 : a > b ? 1 : -1
}

/** 把「整数+小数拼接串」按小数位拆回 [整数, 小数]（小数短则补前导零） */
function split(mag: string, fracLen: number): [string, string] {
  if (mag.length <= fracLen) return ['0', mag.padStart(fracLen, '0')]
  return [mag.slice(0, mag.length - fracLen), mag.slice(mag.length - fracLen)]
}

/** 规范化输出：去前导零/尾随零、-0 → '0' */
function formatResult(negative: boolean, int: string, frac: string): string {
  const intNorm = int.replace(/^0+(?=\d)/, '') || '0'
  const fracNorm = frac.replace(/0+$/, '')
  const body = fracNorm === '' ? intNorm : `${intNorm}.${fracNorm}`
  return negative && body !== '0' ? `-${body}` : body
}

/**
 * 十进制字符串加法（支持负号、不同小数位）。结果规范化：去前导零/尾随零、-0 → '0'。
 */
export function addDecimalStrings(a: string, b: string): string {
  assertDecimal(a)
  assertDecimal(b)
  const aNeg = a.startsWith('-')
  const bNeg = b.startsWith('-')
  const fracLen = Math.max(fracPart(a).length, fracPart(b).length)
  const magA = intPart(a) + fracPart(a).padEnd(fracLen, '0')
  const magB = intPart(b) + fracPart(b).padEnd(fracLen, '0')

  let negative: boolean
  let mag: string
  if (aNeg === bNeg) {
    // 同号相加
    negative = aNeg
    mag = addMagnitude(magA, magB)
  } else {
    // 异号相减，结果符号取绝对值大者
    const cmp = compareMagnitude(magA, magB)
    if (cmp === 0) return '0'
    negative = cmp > 0 ? aNeg : bNeg
    mag = cmp > 0 ? subMagnitude(magA, magB) : subMagnitude(magB, magA)
  }

  const [int, frac] = split(mag, fracLen)
  return formatResult(negative, int, frac)
}

/** 符号翻转；'0' 保持 '0' */
export function negateDecimal(s: string): string {
  assertDecimal(s)
  if (s === '0') return '0'
  return s.startsWith('-') ? s.slice(1) : `-${s}`
}

/** 是否为 0（'0'、'-0'、'0.00' 等形态均视为 0） */
export function isZeroDecimal(s: string): boolean {
  return addDecimalStrings(s, '0') === '0'
}

/** 各金额之和取反（自动平衡补差用）；和为 0 → '0' */
export function computeBalancingNumber(amounts: string[]): string {
  const sum = amounts.reduce((acc, cur) => addDecimalStrings(acc, cur), '0')
  return negateDecimal(sum)
}

/**
 * 金额搜索用的「绝对值规范串」：去符号、去前导零、去小数尾零。
 * `'15.00'` / `'+15'` / `'015'` → `'15'`；`'-17.40'` → `'17.4'`；非法字面量 → `null`。
 *
 * 为什么需要：同一数额在账本里有多种精度写法（实测本机 21454 条 posting 中
 * 0 / 1 / 2 位小数并存），逐字 LIKE 会让「搜 14」漏掉 `14.00`、又误命中 `145.00`。
 * 故搜索走「两侧同口径规范串相等」而非子串匹配。
 * SQL 侧镜像（见 listEntries 的 amount 分支）只做「去符号 + 去小数尾零」——
 * 账本数值由 Beancount 规范化输出（无前导零），前导零只在用户输入侧需要容忍。
 */
export function normalizeAmountMagnitude(raw: string): string | null {
  const m = /^[+-]?(\d+)(?:\.(\d+))?$/.exec(raw.trim())
  if (!m) return null
  const int = m[1]!.replace(/^0+(?=\d)/, '')
  const frac = (m[2] ?? '').replace(/0+$/, '')
  return frac === '' ? int : `${int}.${frac}`
}

/** 十进制字符串比较（含负号）：> 0 / < 0 / === 0。用于排序/分类聚合，纯字符串比较，禁浮点。 */
export function compareDecimalStrings(a: string, b: string): number {
  const aNeg = a.startsWith('-')
  const bNeg = b.startsWith('-')
  if (aNeg !== bNeg) return aNeg ? -1 : 1
  // 同号：绝对值比较，负号时反向
  const cmp = compareMagnitude(body(a), body(b))
  return aNeg ? -cmp : cmp
}
