#!/usr/bin/env node
/**
 * 往来对象 + 贷款核销回填（ADR 23 · step 4 / P2）——一次性迁移脚本。
 *
 * 做两件事：
 * 1. **补 counterparty metadata**：counterparty 维度上线前的往来分录没有标注，往来账会把
 *    它们全归到「未指定」。按「日期 + 金额 + payee 子串」匹配后，在往来类 posting 下补一行
 *    `counterparty: "..."`。
 * 2. **补贷款核销 link**（P2）：交易级 `^link` 是核销的依据，旧分录没有 → 「借出明细」会是
 *    空的。按对象分组、日期升序，每笔借出盖一个新 ID；每笔还款 FIFO 挂到该对象最早的未结借出。
 *
 * 安全性：
 * - **默认 dry-run**，只打印将要做的改动；加 `--apply` 才写盘。
 * - 文本级逐行插入/追加，不重排版、不动其它任何字节。
 * - 两趟各自幂等：已有 counterparty 的 posting、已有 link 的交易都会被跳过。
 * - 写盘走「同目录 tmp → 引擎校验 → rename 原子替换」；校验不过不落盘。
 * - 规则带 payee 子串断言：账本与预期不符会报错而非静默错标。
 *
 * 用法：
 *   node scripts/backfill-counterparty.mjs <账本路径>            # 预览
 *   node scripts/backfill-counterparty.mjs <账本路径> --apply    # 落盘
 *
 * 注意：RULES 是针对 2026-09-13 本机账本、经用户逐条确认的映射，不是通用工具。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/** 往来类账户：本次全部命中此账户（Liabilities:Loans:Repay 当时零使用） */
const LEND = 'Assets:Receivables:Lend'

/**
 * 2026-09-13 用户逐条确认的映射。
 * payee 为账本原文中的「人」线索（用于断言没有标错行），counterparty 为落盘的规范名。
 * 关键判定：08-23「亚峰」与 09-06「李亚峰还款」是同一人 → 统一为「李亚峰」，
 * 否则 +555 / −555 不会冲销；09-03 那笔无任何线索的 −200 归「李江华」。
 */
const RULES = [
  { date: '2026-05-19', amount: '20000', payee: '李素珍', counterparty: '李素珍' },
  { date: '2026-05-19', amount: '5000', payee: '微信转账-李志全', counterparty: '李志全' },
  { date: '2026-05-22', amount: '3000', payee: '微信转账-李志全', counterparty: '李志全' },
  { date: '2026-08-02', amount: '500', payee: '微信转账-李志全', counterparty: '李志全' },
  { date: '2026-08-23', amount: '555', payee: '亚峰', counterparty: '李亚峰' },
  { date: '2026-08-24', amount: '200', payee: '李江华', counterparty: '李江华' },
  { date: '2026-08-31', amount: '500', payee: '李志全', counterparty: '李志全' },
  { date: '2026-09-03', amount: '-200', payee: '', counterparty: '李江华' },
  { date: '2026-09-06', amount: '-555', payee: '李亚峰', counterparty: '李亚峰' },
  { date: '2026-09-10', amount: '3000', payee: '借出3K-枪桑', counterparty: '枪桑' }
]

const TX_RE = /^\d{4}-\d{2}-\d{2}\s+[*!]/
const POSTING_RE = /^(\s+)(\S+)\s+([-+]?\d+(?:\.\d+)?)\s+(\S+)\s*$/
const META_RE = /^\s+([a-zA-Z][A-Za-z0-9_-]*):\s*/
const LINK_RE = /\^([A-Za-z0-9_-]+)/g

const LOAN_PREFIX = 'lend-'

/** 金额归一（'20000.00' 与 '20000' 视为同一笔）：去尾随零、去多余前导符号 */
function normalizeAmount(raw) {
  const negative = raw.startsWith('-')
  const [int, frac = ''] = raw.replace(/^[-+]/, '').split('.')
  const trimmedFrac = frac.replace(/0+$/, '')
  const normalized = trimmedFrac ? `${int}.${trimmedFrac}` : int
  return negative && normalized !== '0' ? `-${normalized}` : normalized
}

/** 归一后必须是整数——FIFO 台帐用整数运算，避免引入浮点（本账本全部满足） */
function toInt(raw) {
  const n = normalizeAmount(raw)
  if (!/^-?\d+$/.test(n)) throw new Error(`金额非整数，本脚本不支持: ${raw}`)
  return Number(n)
}

/**
 * 贷款 ID：**确定性**生成（由「日期 + posting 行号」派生的 10 位 base62），
 * 而不是主进程那种 Math.random —— 为的是 dry-run 预览与实际落盘的 ID 完全一致，
 * 且重复跑脚本结果稳定。格式同为 `lend-<不透明 ASCII 串>`，语义上与主进程无差别。
 */
function newLoanId(seedStr) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let h = 2166136261
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let x = h >>> 0
  let suffix = ''
  for (let i = 0; i < 10; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    suffix += alphabet[x % 62]
  }
  return `${LOAN_PREFIX}${suffix}`
}

function usage() {
  return '用法: node scripts/backfill-counterparty.mjs <账本路径> [--apply]'
}

function main() {
  const [target, ...flags] = process.argv.slice(2)
  if (!target) {
    console.error(usage())
    process.exit(2)
  }
  const apply = flags.includes('--apply')

  const lines = readFileSync(target, 'utf8').split('\n')

  // ---- 第一趟：扫出往来类账户上的分录（带所属交易标题行）
  const found = [] // { headerLine, date, header, postingLine, account, amount, counterparty|null }
  let tx = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (TX_RE.test(line)) {
      tx = { headerLine: i, date: line.slice(0, 10), header: line.slice(11) }
      continue
    }
    if (line.trim() === '' || !/^\s/.test(line)) {
      tx = null
      continue
    }
    if (!tx) continue
    const posting = POSTING_RE.exec(line)
    if (!posting) continue
    const [, , account, amount] = posting
    if (account !== LEND) continue

    let existing = null
    for (let j = i + 1; j < lines.length; j++) {
      const meta = META_RE.exec(lines[j])
      if (!meta) break
      if (meta[1] === 'counterparty') existing = lines[j].slice(meta[0].length).trim().replace(/^"|"$/g, '')
    }
    found.push({ ...tx, postingLine: i, account, amount, counterparty: existing })
  }

  // ---- 判定 1：counterparty 补标
  const cpInsertions = new Map() // 行号 → metadata 行
  const used = new Set()
  const cpSkipped = []
  const warnings = []
  for (const f of found) {
    if (f.counterparty !== null) {
      cpSkipped.push(`${f.date}  ${f.amount}（已有 counterparty: ${f.counterparty}，跳过）`)
      continue
    }
    const idx = RULES.findIndex((r) => r.date === f.date && normalizeAmount(r.amount) === normalizeAmount(f.amount))
    if (idx === -1) {
      warnings.push(`${f.date}  ${f.amount}  在往来类账户上但没有对应规则 → 未标注`)
      continue
    }
    const rule = RULES[idx]
    if (rule.payee && !f.header.includes(rule.payee)) {
      console.error(`✗ 规则断言失败：${f.date} ${f.amount} 期望 payee 含「${rule.payee}」，实际标题 ${JSON.stringify(f.header)}`)
      console.error('  账本与映射预期不符 —— 已中止，未做任何改动。')
      process.exit(1)
    }
    used.add(idx)
    f.counterparty = rule.counterparty
    cpInsertions.set(f.postingLine, `    counterparty: "${rule.counterparty}"`)
  }

  // ---- 判定 2：贷款 link（按对象分组、日期升序，借出盖新 ID，还款 FIFO 挂最早的未结借出）
  const linkedHeaders = new Map() // 标题行号 → [link, ...]
  const linkSkipped = []
  const byCounterparty = new Map()
  for (const f of found) {
    const list = byCounterparty.get(f.counterparty) ?? []
    list.push(f)
    byCounterparty.set(f.counterparty, list)
  }
  let linkCount = 0
  for (const [counterparty, list] of byCounterparty) {
    const ordered = [...list].sort(
      (a, b) => a.date.localeCompare(b.date) || a.postingLine - b.postingLine
    )
    const open = [] // { id, outstanding }（outstanding 为整数，> 0 即未结）
    for (const f of ordered) {
      const headerLinks = [...lines[f.headerLine].matchAll(LINK_RE)].map((m) => m[1])
      if (headerLinks.length > 0) {
        linkSkipped.push(`${f.date}  ${f.amount}（交易已有 link: ${headerLinks.join(', ')}，跳过）`)
        // 仍要让台帐把它计入，否则后续还款会误挂——按金额方向补进 open
        const amount = toInt(f.amount)
        if (amount > 0) open.push({ id: headerLinks[0], outstanding: amount })
        else {
          const target = open.find((l) => l.outstanding > 0)
          if (target) target.outstanding -= Math.abs(amount)
        }
        continue
      }
      const amount = toInt(f.amount)
      if (amount > 0) {
        // 新借出：盖新 ID
        const id = newLoanId(`${f.date}:${f.postingLine}`)
        open.push({ id, outstanding: amount })
        linkedHeaders.set(f.headerLine, [id])
      } else {
        // 还款：FIFO 最早未结
        const target = open.find((l) => l.outstanding > 0)
        if (!target) {
          warnings.push(`${f.date}  ${f.amount}  ${counterparty} 无未结借出可挂 → 未加 link`)
          continue
        }
        target.outstanding -= Math.abs(amount)
        linkedHeaders.set(f.headerLine, [target.id])
      }
      linkCount++
    }
  }

  // ---- 预览
  console.log(`账本：${target}`)
  console.log(`\n[1/2] counterparty：命中 ${cpInsertions.size} 条`)
  for (const [lineNo, meta] of cpInsertions) {
    console.log(`  ${String(lineNo + 1).padStart(6)}  ${lines[lineNo]}`)
    console.log(`          + ${meta.trim()}`)
  }
  for (const s of cpSkipped) console.log(`  [跳过] ${s}`)

  console.log(`\n[2/2] 贷款 link：命中 ${linkCount} 笔交易`)
  for (const [lineNo, ids] of linkedHeaders) {
    console.log(`  ${String(lineNo + 1).padStart(6)}  ${lines[lineNo]}`)
    console.log(`          → ${ids.map((i) => `^${i}`).join(' ')}`)
  }
  for (const s of linkSkipped) console.log(`  [跳过] ${s}`)

  for (const w of warnings) console.log(`  [警告] ${w}`)
  const unused = RULES.map((r, i) => i).filter((i) => !used.has(i))
  if (unused.length > 0) {
    if (cpInsertions.size === 0 && cpSkipped.length > 0) {
      console.log('\n✓ counterparty 已全部就位（此前回填过）。')
    } else {
      console.log('\n⚠️ 以下规则未命中任何分录（账本与映射预期不符，请核对）：')
      for (const i of unused) console.log(`   ${RULES[i].date}  ${RULES[i].amount}  → ${RULES[i].counterparty}`)
    }
  }

  if (!apply) {
    console.log('\n（dry-run，未写盘。确认无误后加 --apply 落盘）')
    return
  }
  if (cpInsertions.size === 0 && linkedHeaders.size === 0) {
    console.log('\n无改动，未写盘。')
    return
  }

  // ---- 落盘：同目录 tmp → 引擎校验 → rename 原子替换
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const ids = linkedHeaders.get(i)
    out.push(ids ? `${lines[i]} ${ids.map((id) => `^${id}`).join(' ')}` : lines[i])
    const meta = cpInsertions.get(i)
    if (meta) out.push(meta)
  }
  const tmp = `${target}.tmp`
  writeFileSync(tmp, out.join('\n'), 'utf8')

  const python = (process.env['BEANWISE_PYTHON_CMD'] ?? 'py -3.11').split(' ')
  const check = spawnSync(
    python[0],
    [
      ...python.slice(1),
      '-c',
      'import sys; from beancount import loader; _, errs, _ = loader.load_file(sys.argv[1]); print(len(errs)); sys.exit(1 if errs else 0)',
      tmp
    ],
    { encoding: 'utf8' }
  )
  if (check.status !== 0) {
    console.error('\n✗ 校验失败，未替换原文件：')
    console.error(check.stdout?.trim(), check.stderr?.trim())
    console.error(`  临时文件保留在 ${tmp}，可自行检查。`)
    process.exit(1)
  }

  renameSync(tmp, target)
  console.log(
    `\n✓ 已写回 ${target}：counterparty ${cpInsertions.size} 条、link ${linkedHeaders.size} 笔（引擎校验通过）`
  )
}

main()
