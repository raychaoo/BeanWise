/**
 * 多文件三路合并引擎（M11，ADR 28）：纯函数、零 IO、零 engine 依赖，可 node 单测。
 *
 * 同步的文件集见 shared/sync-files.ts。每个文件独立走同一个三态外壳：
 *   ours/base/theirs 各自可能为 null（该侧不存在该文件）；
 *   两侧一致 / 仅一侧改动 / 仅一侧删除 → 自动得出结果；
 *   两侧都改 → 按文件类型分派（账本用 diff3 行级合并，JSON 用结构化并集）。
 *
 * **收敛性**（最关键的不变量，避免两台机器来回 ping-pong）：
 * 对同一组 (base, ours, theirs) 输入，合并结果必须逐字节确定，且对 ours/theirs **交换对称**——
 * 因为机器 A 拉取时 ours=A、theirs=B，机器 B 拉取时 ours=B、theirs=A，两者必须得到相同内容，
 * 否则每次同步都会产生新差异。实现上靠三点保证：并集遍历按 key 升序、id 分配只看已占用集合、
 * 需要「取一侧的 id」时统一取 min。属性测试锁死（merge-engine.test.ts）。
 */
import { createHash } from 'node:crypto'
import diff3Merge from 'diff3'
import type { AccountEntry, ExcelImportTemplate, SyncFileConflict } from '../../shared/ipc'
import { SYNC_ACCOUNTS_FILE, SYNC_LEDGER_FILE, SYNC_TEMPLATES_FILE } from '../../shared/sync-files'
import { canonicalAccountBody, normalizeAccounts } from '../utils/account-normalize'
import { normalizeTemplate, normalizeTemplates } from '../excel/template-normalize'

/** 单文件合并结论 */
export type MergeOutcome =
  | { kind: 'unchanged' } // 工作区不动（含「仅本地改动」——本地内容已是正确结果）
  | { kind: 'write'; content: string }
  | { kind: 'delete' } // 从工作区与索引删除该文件
  | { kind: 'conflict' } // 交 UI 人工处理

/** 单文件三态（null = 该侧不存在该文件） */
export interface FileTriple {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
}

export interface MergedFile {
  path: string
  outcome: MergeOutcome
  triple: FileTriple
}

export interface MergePlan {
  files: MergedFile[]
  hasConflict: boolean
  /** 冲突文件的三路快照（IPC 直传渲染端） */
  conflicts: SyncFileConflict[]
}

/** 行分割（保留行尾符），与 isomorphic-git 内部 mergeFile 的 LINEBREAKS 一致 */
const LINEBREAKS = /^.*(\r?\n|$)/gm

/**
 * 文件级三路合并（diff3，同 isomorphic-git 内置算法）。
 * 无冲突 → cleanMerge=true 返回合并文本；有冲突 → cleanMerge=false，
 * 冲突 hunk 不产出文本（marker:false 语义），调用方改用三路快照交 UI 处理。
 */
function mergeFile(ours: string, base: string, theirs: string): { cleanMerge: boolean; mergedText: string } {
  const result = diff3Merge(
    ours.match(LINEBREAKS) ?? [],
    base.match(LINEBREAKS) ?? [],
    theirs.match(LINEBREAKS) ?? []
  )
  let cleanMerge = true
  let mergedText = ''
  for (const item of result) {
    if ('ok' in item) {
      mergedText += item.ok.join('')
    } else {
      cleanMerge = false
    }
  }
  return { cleanMerge, mergedText }
}

const UNCHANGED: MergeOutcome = { kind: 'unchanged' }
const CONFLICT: MergeOutcome = { kind: 'conflict' }

/**
 * 三态外壳（所有文件类型共用）。`diverged` 仅在「base 与两侧都不同且两侧互不相同」时调用，
 * 此时 base 可能为 null（两个互不相关的历史各自新增了该文件）。
 */
export function mergeThreeWay(
  ours: string | null,
  base: string | null,
  theirs: string | null,
  diverged: (ours: string, base: string | null, theirs: string) => MergeOutcome
): MergeOutcome {
  if (ours === theirs) return UNCHANGED // 含两侧都 null
  if (base === theirs) return UNCHANGED // 仅本地改动（含本地删除；本地内容即正确结果）
  if (base === ours) return theirs === null ? { kind: 'delete' } : { kind: 'write', content: theirs }
  if (ours === null || theirs === null) return CONFLICT // 一方删除、另一方改写 → 交人工
  return diverged(ours, base, theirs)
}

/** 账本文本合并（diff3 行级） */
export function textDiverged(ours: string, base: string | null, theirs: string): MergeOutcome {
  const merged = mergeFile(ours, base ?? '', theirs)
  if (!merged.cleanMerge) return CONFLICT
  return merged.mergedText === ours ? UNCHANGED : { kind: 'write', content: merged.mergedText }
}

/**
 * JSON 文件的结构化 codec：把「并集算法」与「具体条目形状」解耦，
 * 账户库（键 = value）与 Excel 模板（键 = source）共用同一套三态/并集/id 分配逻辑。
 */
interface JsonSyncCodec<T> {
  /** 解析 + 逐条校验；抛错 → 该文件按冲突处理（用户需先修好文件） */
  parse(text: string): T[]
  /** 并集键（两侧同一键视为同一条目） */
  key(item: T): string
  /** 规范体（去 id）：判断「同一条目两侧是否一致」的比较基准 */
  body(item: T): string
  idOf(item: T): string
  withId(item: T, id: string): T
  /** 全新 id 分配器（n 从 1 递增；返回值必须确定，跨机器一致） */
  freshId(key: string, n: number): string
  /** 序列化（必须与对应 Json*Store.save 逐字节同形） */
  serialize(items: T[]): string
}

/** id 中最大的整数（非数字 id 视作 0）——accounts 用它保证新 id 不与既有 id 撞号 */
function numericCeiling(ids: Iterable<string>): number {
  let max = 0
  for (const id of ids) {
    const n = Number(id)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max
}

function minId(a: string, b: string): string {
  return a < b ? a : b
}

/**
 * 结构化并集（三态外壳之下的 diverged 实现）。
 *
 * 逐条规则与 id 分配见 technical-proposal/data-consistency.md「同步文件集与合并算法」。
 * 收敛性要点：遍历按 key 升序、`used` 的初值来自 base（两侧相同）、prefId 取 min（对称）、
 * freshId 由 (key, n) 纯函数派生（对称）。
 */
function unionMerge<T>(codec: JsonSyncCodec<T>, ours: string, base: string | null, theirs: string): MergeOutcome {
  let oItems: T[]
  let tItems: T[]
  let bItems: T[]
  try {
    oItems = codec.parse(ours)
    tItems = codec.parse(theirs)
    bItems = base === null ? [] : codec.parse(base)
  } catch {
    return CONFLICT // 文件损坏 / 条目非法 → 不猜，交人工
  }

  const bMap = new Map(bItems.map((i) => [codec.key(i), i] as const))
  const oMap = new Map(oItems.map((i) => [codec.key(i), i] as const))
  const tMap = new Map(tItems.map((i) => [codec.key(i), i] as const))

  interface Chosen { key: string; item: T; baseId: string | null; prefId: string }
  const chosen: Chosen[] = []

  for (const key of [...new Set([...oMap.keys(), ...tMap.keys()])].sort()) {
    const oe = oMap.get(key)
    const te = tMap.get(key)
    const be = bMap.get(key)
    const beBody = be === undefined ? null : codec.body(be)

    if (oe !== undefined && te !== undefined) {
      const ob = codec.body(oe)
      const tb = codec.body(te)
      if (ob === tb) {
        chosen.push({ key, item: oe, baseId: be ? codec.idOf(be) : null, prefId: be ? codec.idOf(be) : minId(codec.idOf(oe), codec.idOf(te)) })
      } else if (be && ob === beBody) {
        chosen.push({ key, item: te, baseId: codec.idOf(be), prefId: codec.idOf(be) }) // 仅远端改
      } else if (be && tb === beBody) {
        chosen.push({ key, item: oe, baseId: codec.idOf(be), prefId: codec.idOf(be) }) // 仅本地改
      } else {
        return CONFLICT // 两侧都改且不同（或 base 无此条目却各写了一份）
      }
    } else if (oe !== undefined) {
      if (!be) chosen.push({ key, item: oe, baseId: null, prefId: codec.idOf(oe) })
      else if (codec.body(oe) === beBody) continue // 远端删除、本地未改 → 删除生效
      else return CONFLICT // 远端删除、本地改过
    } else if (te !== undefined) {
      if (!be) chosen.push({ key, item: te, baseId: null, prefId: codec.idOf(te) })
      else if (codec.body(te) === beBody) continue // 本地删除、远端未改 → 删除生效
      else return CONFLICT // 本地删除、远端改过
    }
  }

  // id 分配：base 的全部 id（含已被删除条目的）都视为已占用，避免 id 被新条目复用
  const used = new Set<string>(bItems.map((i) => codec.idOf(i)))
  const fresh: Chosen[] = []
  const merged: T[] = []
  for (const c of chosen) {
    if (c.baseId !== null) {
      merged.push(codec.withId(c.item, c.baseId))
    } else {
      fresh.push(c)
    }
  }
  let n = numericCeiling([...used, ...fresh.map((c) => c.prefId)]) + 1
  for (const c of fresh) {
    let id = c.prefId
    if (used.has(id)) {
      do {
        id = codec.freshId(c.key, n++)
      } while (used.has(id))
    }
    used.add(id)
    merged.push(codec.withId(c.item, id))
  }

  const text = codec.serialize(merged)
  return text === ours ? UNCHANGED : { kind: 'write', content: text }
}

/** 账户库文件文本 → 条目数组（解析 + 逐条校验；抛错即文件非法） */
export function parseAccountsFile(text: string): AccountEntry[] {
  const raw = JSON.parse(text) as { accounts?: unknown } | null
  if (raw === null || typeof raw !== 'object') throw new Error('accounts.json 结构非法')
  return normalizeAccounts(raw.accounts ?? [])
}

/** Excel 模板文件文本 → 模板数组（解析 + 逐条校验 + 同 source 收敛） */
export function parseTemplatesFile(text: string): ExcelImportTemplate[] {
  const raw = JSON.parse(text) as { templates?: unknown } | null
  if (raw === null || typeof raw !== 'object') throw new Error('excel-import-templates.json 结构非法')
  return normalizeTemplates(raw.templates ?? [])
}

/** 账户库 codec（键 = value：normalizeAccounts 已强制唯一） */
const ACCOUNTS_CODEC: JsonSyncCodec<AccountEntry> = {
  parse: parseAccountsFile,
  key: (e) => e.value,
  body: (e) => canonicalAccountBody(e),
  idOf: (e) => String(e.id),
  withId: (e, id) => ({ ...e, id: Number(id) }),
  freshId: (_key, n) => String(n), // accounts 的 id 是自增整数
  serialize: (items) => JSON.stringify({ accounts: [...items].sort((a, b) => a.id - b.id) }, null, 2)
}

/** Excel 模板 codec（键 = source：去重语义键，跨机器同源模板必须收敛为一条） */
const TEMPLATES_CODEC: JsonSyncCodec<ExcelImportTemplate> = {
  parse: parseTemplatesFile,
  key: (t) => t.source,
  body: (t) => JSON.stringify(normalizeTemplate({ ...t, id: '' })),
  idOf: (t) => t.id,
  withId: (t, id) => ({ ...t, id }),
  // 模板 id 是字符串（本地为 excel-<时间><随机>，跨机器无语义）→ 由 source 派生，
  // 两台机器各自新建同 source 模板时会得到同一个 id（收敛）
  freshId: (key, n) => `excel-${createHash('sha1').update(`beanwise-template:${key}:${n}`).digest('hex').slice(0, 12)}`,
  serialize: (items) =>
    JSON.stringify(
      { templates: [...items].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)) },
      null,
      2
    )
}

/**
 * 单文件合并（按路径选 codec；未知路径按文本处理）。
 * `ledgerFile` = 账本在工作区中的实际文件名（产品固定 main.beancount，测试可能不同）——
 * 仅用于「账本不允许被删除」这条守卫的识别。
 */
export function mergeForPath(triple: FileTriple, ledgerFile: string = SYNC_LEDGER_FILE): MergeOutcome {
  const { path, ours, base, theirs } = triple
  const outcome = mergeThreeWay(ours, base, theirs, (o, b, t) => {
    if (path === SYNC_ACCOUNTS_FILE) return unionMerge(ACCOUNTS_CODEC, o, b, t)
    if (path === SYNC_TEMPLATES_FILE) return unionMerge(TEMPLATES_CODEC, o, b, t)
    return textDiverged(o, b, t)
  })
  // 账本是产品主文件（workspace:open 会重建空文件）：远端删除降级为清空，不真删
  if (outcome.kind === 'delete' && path === ledgerFile) return { kind: 'write', content: '' }
  return outcome
}

/** 逐文件合并 → 计划（含冲突快照） */
export function mergeTrackedFiles(triples: FileTriple[], ledgerFile: string = SYNC_LEDGER_FILE): MergePlan {
  const files: MergedFile[] = triples.map((triple) => ({ path: triple.path, triple, outcome: mergeForPath(triple, ledgerFile) }))
  const conflicts: SyncFileConflict[] = files
    .filter((f) => f.outcome.kind === 'conflict')
    .map((f) => ({ path: f.path, base: f.triple.base, ours: f.triple.ours, theirs: f.triple.theirs }))
  return { files, hasConflict: conflicts.length > 0, conflicts }
}
