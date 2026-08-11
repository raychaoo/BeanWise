# M8 图表报表 + 发布加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地报表视图（净资产趋势 / 收支对比 / 账户余额树，Ant Charts + SQLite 精确聚合），接通 electron-updater 升级链（检查→下载→安装），按「无签名」口径完成发布加固与文档定稿。

**Architecture:** 主进程新增 `report:` 域三通道（SQL 只做行筛选排序，金额累计全走 `decimal.ts` 字符串加法）+ `update:` 域三通道（updater 状态机封装 electron-updater，事件经 `update:status-changed` 推送）；渲染端新增 ReportsView（Line/Column/树表格）+ UpdateModal；E2E 走进程内 mock 更新源（复用 git-test-server 模式）；发布管线已有 tag→Release 框架，按无签名口径核对调整。

**Tech Stack:** @ant-design/charts 2.6.7（新依赖，peer `react >=16.8.4` 满足 React 19）· electron-updater（新依赖）· Drizzle · Zustand · Vitest + Playwright（进程内 mock 更新源服务器）

## Global Constraints

- **设计 spec**：`docs/superpowers/specs/2026-08-11-m8-reports-release-design.md`（任务实现前先读）
- **金额十进制字符串铁律**：SQL 禁止 `SUM()`（TEXT→REAL 丢精度）；聚合一律 `addDecimalStrings`（`src/shared/decimal.ts`）；图表 y 值 `Number()` 转换**仅显示层**（工具提示/坐标轴），精确金额由余额表十进制字符串提供
- **IPC 契约链路**：`src/shared/ipc.ts` 类型唯一来源 → preload 白名单 → main handler 注册，禁止旁路；handler 内非法入参 `throw`（invoke reject，与 add-entry/save-file 同约定）
- **多货币**：趋势图只按运营货币聚合（`ledger_meta.operating_currency` 主币），余额树全部币种分行
- **升级链**：生产走 electron-builder `app-update.yml`（provider github）；`BEANWISE_UPDATE_FEED_URL` 环境变量注入时 `setFeedURL` + `forceDevUpdateConfig`（测试/E2E）；E2E 断言到 `downloaded` 为止，不触发 `quitAndInstall`（安装替换留首版人工演练）
- **无签名**：不配 `CSC_*` secrets；release.yml 保留 `CSC_IDENTITY_AUTO_DISCOVERY=false`（electron-builder 无证书即跳过签名）；SmartScreen 风险记录于 release-pipeline.md
- **与 spec 的偏差（已裁决）**：① `income = -ΣIncome:*` 显示为正（spec 写 `ΣIncome:*`——Beancount Income 为负、图表展示口径与 Fava 一致）；② E2E 图表断言以「IPC 返回数据 + DOM 容器存在 + 余额表精确文本」为准（canvas 渲染文本不可 DOM 断言）；③ 升级 E2E 在 CI（ubuntu/AppImageUpdater）与 Windows（NsisUpdater）双平台路径：latest.yml 同时声明 `.AppImage` 与 `.exe` 条目，断言状态流转与平台无关
- **测试命令**：`npm run typecheck`（node + web 双 tsconfig）、`npm run test:unit -- <path>`、`npm run test:e2e`（需先 `npm run build`；VS Code 终端先 `env -u ELECTRON_RUN_AS_NODE`）
- **提交规范**：中文 message 带 `（M8-Tn）` 后缀；不加 Co-Authored-By（用户明令）
- **验证钩子**：每个任务结束必须 `npm run typecheck && npm run test:unit` 全绿再 commit

---

## Task 1（M8-T1）：依赖 + report/update 域 IPC 契约 + preload 白名单

**Files:**
- Modify: `package.json`（`npm install` 两个新依赖）
- Modify: `src/shared/ipc.ts`（追加 report/update 域类型 + 6 通道 + 事件通道常量）
- Modify: `src/shared/api.ts`（BeanWiseApi 追加 7 方法，含事件订阅）
- Modify: `src/preload/index.ts`（白名单追加 7 项）

**Interfaces:**
- Produces（shared/ipc.ts）：`ReportGranularity = 'month' | 'year'`、`ReportNetWorthParams { granularity }`、`NetWorthPoint { period: string; assets: string; liabilities: string; netWorth: string }`、`ReportNetWorthResult { series: NetWorthPoint[]; currency: string; message?: string }`、`AccountBalance { name: string; balances: Array<{ currency: string; number: string }>; children?: AccountBalance[] }`、`ReportBalancesResult { accounts: AccountBalance[]; message?: string }`、`ReportIncomeExpenseParams { granularity; year?: number }`、`IncomeExpensePoint { period: string; income: string; expense: string }`、`ReportIncomeExpenseResult { series; currency; message? }`、`UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'`、`UpdateState { status; currentVersion: string; availableVersion?: string; progress?: number; error?: string }`、`UpdateCheckResult { ok; message? }`、`UpdateInstallResult { ok; message? }`、`UPDATE_STATUS_CHANNEL = 'update:status-changed'`、`IpcChannel` 追加 6 值
- Produces（api.ts）：`getNetWorthReport(params) → Promise<ReportNetWorthResult>`、`getBalancesReport() → Promise<ReportBalancesResult>`、`getIncomeExpenseReport(params) → Promise<ReportIncomeExpenseResult>`、`checkForUpdates() → Promise<UpdateCheckResult>`、`getUpdateStatus() → Promise<UpdateState>`、`installUpdate() → Promise<UpdateInstallResult>`、`onUpdateStatusChanged(cb: (state: UpdateState) => void): () => void`（返回取消订阅函数）

- [ ] **Step 1: 安装依赖**

```bash
npm install electron-updater @ant-design/charts
```

验证：`package.json` dependencies 出现 `electron-updater` 与 `@ant-design/charts`（约 2.6.x）。

- [ ] **Step 2: 追加 report/update 域 IPC 契约（纯类型，typecheck 验证）**

`src/shared/ipc.ts`：`IpcChannel` 追加两域（report 三通道 + update 三通道）：

```ts
export type IpcChannel = 'ledger:refresh-index' | 'ledger:status' | 'ledger:list-entries'
  | 'ledger:add-entry' | 'ledger:list-accounts' | 'ledger:read-file' | 'ledger:save-file'
  | 'sync:get-status' | 'sync:configure' | 'sync:push' | 'sync:pull'
  | 'sync:resolve-conflict' | 'sync:clear'
  | 'ai:get-status' | 'ai:save-config' | 'ai:clear-config' | 'ai:parse'
  | 'report:net-worth' | 'report:balances' | 'report:income-expense'
  | 'update:check' | 'update:status' | 'update:install'
```

文件末尾追加：

```ts
/** M8：报表域（数据源 = SQLite 索引行 → 主进程 decimal.ts 精确聚合，SQL 不 SUM） */

/** 报表粒度（月 YYYY-MM / 年 YYYY） */
export type ReportGranularity = 'month' | 'year'

/** report:net-worth 入参 */
export interface ReportNetWorthParams {
  granularity: ReportGranularity
}

/** 净资产趋势点（decimal 字符串） */
export interface NetWorthPoint {
  period: string // 'YYYY-MM' 或 'YYYY'
  assets: string
  liabilities: string
  netWorth: string // = assets + liabilities（Beancount 负债为负）
}

/** report:net-worth 结果（currency 为运营货币，其他币种已排除） */
export interface ReportNetWorthResult {
  series: NetWorthPoint[]
  currency: string
  message?: string
}

/** 账户余额树节点：balances = 子树各币种合计（rollup），children 按名称字典序 */
export interface AccountBalance {
  name: string
  balances: Array<{ currency: string; number: string }>
  children?: AccountBalance[]
}

/** report:balances 结果（全部币种分行） */
export interface ReportBalancesResult {
  accounts: AccountBalance[]
  message?: string
}

/** report:income-expense 入参（year 仅月视图有意义，缺省 = 最近有数据的年份） */
export interface ReportIncomeExpenseParams {
  granularity: ReportGranularity
  year?: number
}

/** 收支对比点（income/expense 均为正显示：income=-ΣIncome:*，expense=-ΣExpenses:*） */
export interface IncomeExpensePoint {
  period: string
  income: string
  expense: string
}

/** report:income-expense 结果 */
export interface ReportIncomeExpenseResult {
  series: IncomeExpensePoint[]
  currency: string
  message?: string
}

/** M8：更新域（electron-updater 状态机，主进程持有） */

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

/** update:status 结果 / update:status-changed 事件载荷 */
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  /** 下载进度 0~100 */
  progress?: number
  error?: string
}

/** update:check 结果 */
export interface UpdateCheckResult {
  ok: boolean
  message?: string
}

/** update:install 结果 */
export interface UpdateInstallResult {
  ok: boolean
  message?: string
}

/** main → renderer 事件通道（更新状态推送，白名单常量） */
export const UPDATE_STATUS_CHANNEL = 'update:status-changed'
```

- [ ] **Step 3: BeanWiseApi 追加 7 方法**

`src/shared/api.ts`：import 追加类型，接口末尾追加：

```ts
  /** 净资产趋势（SQLite 精确聚合，运营货币） */
  getNetWorthReport(params: ReportNetWorthParams): Promise<ReportNetWorthResult>
  /** 账户余额树（全部币种分行） */
  getBalancesReport(): Promise<ReportBalancesResult>
  /** 收支对比（income/expense 正显示） */
  getIncomeExpenseReport(params: ReportIncomeExpenseParams): Promise<ReportIncomeExpenseResult>
  /** 检查更新（触发 updater 状态机） */
  checkForUpdates(): Promise<UpdateCheckResult>
  /** 当前更新状态（idle/checking/available/downloading/downloaded/error） */
  getUpdateStatus(): Promise<UpdateState>
  /** 下载完成后安装并重启 */
  installUpdate(): Promise<UpdateInstallResult>
  /** 订阅更新状态推送（main → renderer 事件），返回取消订阅函数 */
  onUpdateStatusChanged(cb: (state: UpdateState) => void): () => void
```

- [ ] **Step 4: preload 白名单追加**

`src/preload/index.ts`：

```ts
import { UPDATE_STATUS_CHANNEL, type ... } from '../shared/ipc'
// api 对象内追加：
  getNetWorthReport: (params: ReportNetWorthParams) => ipcRenderer.invoke('report:net-worth', params),
  getBalancesReport: () => ipcRenderer.invoke('report:balances'),
  getIncomeExpenseReport: (params: ReportIncomeExpenseParams) => ipcRenderer.invoke('report:income-expense', params),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatusChanged: (cb: (state: UpdateState) => void) => {
    const listener = (_e: unknown, state: UpdateState) => cb(state)
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener)
    return () => { ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener) }
  }
```

- [ ] **Step 5: typecheck 验证 + 提交**

```bash
npm run typecheck
```

Expected: PASS（无新错误）。handler 未注册，通道类型先落地不影响编译。

```bash
git add package.json package-lock.json src/shared/ipc.ts src/shared/api.ts src/preload/index.ts
git commit -m "feat: M8 report/update 域 IPC 契约 + 依赖（M8-T1）"
```

---

## Task 2（M8-T2）：report-aggregation 纯函数（TDD）

**Files:**
- Create: `src/main/report-aggregation.ts`
- Test: `src/main/report-aggregation.test.ts`

**Interfaces:**
- Consumes: `addDecimalStrings` / `negateDecimal`（`src/shared/decimal.ts`）、类型 `NetWorthPoint` / `AccountBalance` / `IncomeExpensePoint`（`src/shared/ipc.ts`）
- Produces: `PostingRow { date: string; account: string; number: string; currency: string }`、`periodOf(date, granularity): string`、`computeNetWorth(rows, granularity, currency): NetWorthPoint[]`（行按日期升序入参，按期间累计）、`buildAccountTree(rows): AccountBalance[]`（叶子余额 → `.` 前缀树 + 子树各币种 rollup）、`computeIncomeExpense(rows, granularity, currency, year?): IncomeExpensePoint[]`（月视图补满 12 个月，year 缺失时由 handler 决定——函数要求 year 必传）

- [ ] **Step 1: 写失败测试**

`src/main/report-aggregation.test.ts`：

```ts
/**
 * M8-T2：报表聚合纯函数测试。金额全部十进制字符串精确运算（decimal.ts），
 * 口径：趋势图按运营货币过滤；余额树多币种分行 + 子树 rollup；收支正显示。
 */
import { describe, expect, it } from 'vitest'
import type { PostingRow } from './report-aggregation'
import { buildAccountTree, computeIncomeExpense, computeNetWorth, periodOf } from './report-aggregation'

const rows: PostingRow[] = [
  // 2025-03 收入 + 支出
  { date: '2025-03-01', account: 'Assets:Bank:CNB', number: '10000.00', currency: 'CNY' },
  { date: '2025-03-01', account: 'Income:Salary', number: '-10000.00', currency: 'CNY' },
  { date: '2025-03-05', account: 'Expenses:Food', number: '35.00', currency: 'CNY' },
  { date: '2025-03-05', account: 'Assets:Bank:CNB', number: '-35.00', currency: 'CNY' },
  // 2025-06 支出
  { date: '2025-06-10', account: 'Expenses:Transport', number: '5.00', currency: 'CNY' },
  { date: '2025-06-10', account: 'Assets:Bank:CNB', number: '-5.00', currency: 'CNY' },
  // 2026-01 信用卡支出（负债）
  { date: '2026-01-05', account: 'Expenses:Food', number: '20.00', currency: 'CNY' },
  { date: '2026-01-05', account: 'Liabilities:CreditCard', number: '-20.00', currency: 'CNY' },
  // 2026-02 收入（另一币种，趋势应被过滤）
  { date: '2026-02-01', account: 'Assets:Bank:USD', number: '100.00', currency: 'USD' },
  { date: '2026-02-01', account: 'Income:Salary', number: '-100.00', currency: 'USD' }
]

describe('periodOf', () => {
  it('month → YYYY-MM，year → YYYY', () => {
    expect(periodOf('2026-08-11', 'month')).toBe('2026-08')
    expect(periodOf('2026-08-11', 'year')).toBe('2026')
  })
})

describe('computeNetWorth（按期间累计，运营货币过滤）', () => {
  it('month：逐月累计 assets/liabilities，netWorth = 两者之和', () => {
    const pts = computeNetWorth(rows, 'month', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025-03', '2025-06', '2026-01', '2026-02'])
    // 2025-03 末：assets = 10000 - 35 = 9965，liabilities = 0
    expect(pts[0]).toEqual({ period: '2025-03', assets: '9965', liabilities: '0', netWorth: '9965' })
    // 2025-06 末：assets = 9965 - 5 = 9960
    expect(pts[1]).toEqual({ period: '2025-06', assets: '9960', liabilities: '0', netWorth: '9960' })
    // 2026-01 末：assets 仍 9960，liabilities = -20 → netWorth = 9940
    expect(pts[2]).toEqual({ period: '2026-01', assets: '9960', liabilities: '-20', netWorth: '9940' })
    // 2026-02：USD 行被过滤（currency !== CNY）→ 与 1 月相同
    expect(pts[3]).toEqual({ period: '2026-02', assets: '9960', liabilities: '-20', netWorth: '9940' })
  })

  it('year：按年累计', () => {
    const pts = computeNetWorth(rows, 'year', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025', '2026'])
    expect(pts[0].assets).toBe('9960')
    expect(pts[1]).toEqual({ period: '2026', assets: '9960', liabilities: '-20', netWorth: '9940' })
  })

  it('空输入 → 空数组', () => {
    expect(computeNetWorth([], 'month', 'CNY')).toEqual([])
  })
})

describe('buildAccountTree（叶子余额 + 子树 rollup + 多币种分行）', () => {
  it('按 . 前缀建树，节点 balances 为子树各币种合计', () => {
    const tree = buildAccountTree(rows)
    const assets = tree.find((n) => n.name === 'Assets')!
    expect(assets.balances).toContainEqual({ currency: 'CNY', number: '9960' })
    expect(assets.balances).toContainEqual({ currency: 'USD', number: '100' })
    const bank = assets.children!.find((n) => n.name === 'Assets:Bank')!
    expect(bank.balances).toEqual([{ currency: 'CNY', number: '9960' }])
    const cnb = bank.children!.find((n) => n.name === 'Assets:Bank:CNB')!
    expect(cnb.balances).toEqual([{ currency: 'CNY', number: '9960' }])
    expect(cnb.children).toBeUndefined()
    // 负债为负
    const liab = tree.find((n) => n.name === 'Liabilities')!
    expect(liab.balances).toEqual([{ currency: 'CNY', number: '-20' }])
    // 叶子数 = 聚合账户数（CNY 5 个 + USD 1 个，均不含父级）
    const leaves = tree.flatMap((n) => n.children ?? []).flatMap((n) => n.children ?? [])
    expect(leaves.map((n) => n.name)).toEqual(['Assets:Bank:CNB', 'Assets:Bank:USD', 'Liabilities:CreditCard'])
  })

  it('空输入 → 空数组', () => {
    expect(buildAccountTree([])).toEqual([])
  })
})

describe('computeIncomeExpense（正显示 + 月视图补满 12 个月 + 年过滤）', () => {
  it('month + year=2026：12 个月全量，income = -ΣIncome:*，expense = -ΣExpenses:*', () => {
    const pts = computeIncomeExpense(rows, 'month', 'CNY', 2026)
    expect(pts).toHaveLength(12)
    const jan = pts.find((p) => p.period === '2026-01')!
    expect(jan).toEqual({ period: '2026-01', income: '0', expense: '20' })
    const feb = pts.find((p) => p.period === '2026-02')!
    expect(feb).toEqual({ period: '2026-02', income: '0', expense: '0' }) // USD 收入被过滤
    expect(pts.every((p) => p.period.startsWith('2026-'))).toBe(true)
  })

  it('year：全历史按年分组，income/expense 正显示', () => {
    const pts = computeIncomeExpense(rows, 'year', 'CNY')
    expect(pts.map((p) => p.period)).toEqual(['2025', '2026'])
    expect(pts[0]).toEqual({ period: '2025', income: '10000', expense: '40' })
    expect(pts[1]).toEqual({ period: '2026', income: '0', expense: '20' })
  })

  it('year 过滤：只算该年', () => {
    const pts = computeIncomeExpense(rows, 'year', 'CNY', 2025)
    expect(pts.map((p) => p.period)).toEqual(['2025'])
    expect(pts[0].expense).toBe('40')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run test:unit -- src/main/report-aggregation.test.ts
```

Expected: FAIL（`Cannot find module './report-aggregation'`）。

- [ ] **Step 3: 实现 report-aggregation.ts**

`src/main/report-aggregation.ts`：

```ts
/**
 * M8 报表聚合纯函数（T2）。数据源 = SQLite 索引行（SQL 只做行筛选/排序），
 * 金额累计一律 addDecimalStrings 精确字符串运算——SQLite SUM() 转 REAL 丢精度，禁用。
 * 口径：趋势图按运营货币过滤；余额树多币种分行 + 子树 rollup；收支正显示（income=-ΣIncome:*）。
 */
import { addDecimalStrings, negateDecimal } from '../shared/decimal'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint } from '../shared/ipc'

/** 索引行快照（ipc-handlers-report 查询产出） */
export interface PostingRow {
  date: string // YYYY-MM-DD
  account: string
  number: string // 十进制字符串
  currency: string
}

/** 期间桶：month → 'YYYY-MM'，year → 'YYYY' */
export function periodOf(date: string, granularity: 'month' | 'year'): string {
  return granularity === 'year' ? date.slice(0, 4) : date.slice(0, 7)
}

/**
 * 净资产趋势：按期间累计 assets/liabilities（行须按日期升序），netWorth = assets + liabilities
 * （Beancount 负债为负）。非运营货币行直接跳过。
 */
export function computeNetWorth(
  rows: PostingRow[],
  granularity: 'month' | 'year',
  currency: string
): NetWorthPoint[] {
  const buckets = new Map<string, { assets: string; liabilities: string }>()
  for (const r of rows) {
    if (r.currency !== currency) continue
    const period = periodOf(r.date, granularity)
    const b = buckets.get(period) ?? { assets: '0', liabilities: '0' }
    if (r.account.startsWith('Assets:')) b.assets = addDecimalStrings(b.assets, r.number)
    else if (r.account.startsWith('Liabilities:')) b.liabilities = addDecimalStrings(b.liabilities, r.number)
    buckets.set(period, b)
  }
  const points: NetWorthPoint[] = []
  let assets = '0'
  let liabilities = '0'
  for (const period of [...buckets.keys()].sort()) {
    const b = buckets.get(period)!
    assets = addDecimalStrings(assets, b.assets)
    liabilities = addDecimalStrings(liabilities, b.liabilities)
    points.push({ period, assets, liabilities, netWorth: addDecimalStrings(assets, liabilities) })
  }
  return points
}

/**
 * 账户余额树：叶子余额按 (账户, 币种) 聚合 → 按 '.' 前缀建树，
 * 每个节点 balances = 子树各币种合计（递归 rollup），children 按名称字典序。
 */
export function buildAccountTree(rows: PostingRow[]): AccountBalance[] {
  const sums = new Map<string, Map<string, string>>() // account → currency → number
  for (const r of rows) {
    let m = sums.get(r.account)
    if (!m) {
      m = new Map()
      sums.set(r.account, m)
    }
    m.set(r.currency, addDecimalStrings(m.get(r.currency) ?? '0', r.number))
  }
  const nodes = new Map<string, AccountBalance>()
  const roots: AccountBalance[] = []
  for (const [account, byCurrency] of [...sums.entries()].sort()) {
    let parent: AccountBalance | undefined
    let path = ''
    for (const part of account.split(':')) {
      path = path ? `${path}:${part}` : part
      let node = nodes.get(path)
      if (!node) {
        node = { name: path, balances: [], children: [] }
        nodes.set(path, node)
        if (parent) parent.children!.push(node)
        else roots.push(node)
      }
      parent = node
    }
    parent!.balances = [...byCurrency.entries()].map(([currency, number]) => ({ currency, number }))
  }
  function rollup(node: AccountBalance): Map<string, string> {
    const agg = new Map(node.balances.map((b) => [b.currency, b.number] as const))
    for (const child of node.children ?? []) {
      for (const [cur, num] of rollup(child)) agg.set(cur, addDecimalStrings(agg.get(cur) ?? '0', num))
    }
    node.balances = [...agg.entries()].map(([currency, number]) => ({ currency, number }))
    return agg
  }
  const sortRec = (n: AccountBalance): void => {
    n.children?.sort((a, b) => a.name.localeCompare(b.name))
    n.children?.forEach(sortRec)
  }
  for (const node of roots) rollup(node)
  roots.forEach(sortRec)
  return roots.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 收支对比：income = -ΣIncome:*（正显示），expense = -ΣExpenses:*（正显示）。
 * month 粒度 year 必传（handler 缺省解析最近年份），补满 12 个月（无数据月为 0）；
 * year 粒度按全历史年份分组。
 */
export function computeIncomeExpense(
  rows: PostingRow[],
  granularity: 'month' | 'year',
  currency: string,
  year?: number
): IncomeExpensePoint[] {
  const incomeMap = new Map<string, string>()
  const expenseMap = new Map<string, string>()
  for (const r of rows) {
    if (r.currency !== currency) continue
    if (year !== undefined && r.date.slice(0, 4) !== String(year)) continue
    const period = periodOf(r.date, granularity)
    if (r.account.startsWith('Income:')) incomeMap.set(period, addDecimalStrings(incomeMap.get(period) ?? '0', r.number))
    else if (r.account.startsWith('Expenses:')) expenseMap.set(period, addDecimalStrings(expenseMap.get(period) ?? '0', r.number))
  }
  if (granularity === 'month') {
    const points: IncomeExpensePoint[] = []
    for (let m = 1; m <= 12; m++) {
      const period = `${year}-${String(m).padStart(2, '0')}`
      points.push({
        period,
        income: negateDecimal(incomeMap.get(period) ?? '0'),
        expense: negateDecimal(expenseMap.get(period) ?? '0')
      })
    }
    return points
  }
  const periods = [...new Set([...incomeMap.keys(), ...expenseMap.keys()])].sort()
  return periods.map((period) => ({
    period,
    income: negateDecimal(incomeMap.get(period) ?? '0'),
    expense: negateDecimal(expenseMap.get(period) ?? '0')
  }))
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm run test:unit -- src/main/report-aggregation.test.ts
```

Expected: PASS（13 个用例全绿）。

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run typecheck && npm run test:unit
```

```bash
git add src/main/report-aggregation.ts src/main/report-aggregation.test.ts
git commit -m "feat: 报表聚合纯函数（净资产/余额树/收支，decimal 精确运算）（M8-T2）"
```

---

## Task 3（M8-T3）：report 域 IPC handlers + 主进程注册（TDD）

**Files:**
- Create: `src/main/ipc-handlers-report.ts`
- Test: `src/main/ipc-handlers-report.test.ts`
- Modify: `src/main/index.ts`（`registerReportHandlers` 接线）

**Interfaces:**
- Consumes: `PostingRow` / `computeNetWorth` / `buildAccountTree` / `computeIncomeExpense`（T2）、`IpcRegistrar`（`ipc-handlers.ts` 导出）、`DrizzleDb`（`./db`）、`postings` / `entries`（`./db/schema`）、`getLedgerStatus`（`./index-builder`）、shared/ipc 类型（T1）
- Produces: `registerReportHandlers(ipc: IpcRegistrar, deps: ReportDeps): void`，`ReportDeps { db: DrizzleDb }`
- 行为契约：`report:net-worth` 返回 `{ series, currency, message? }`；`report:balances` 返回 `{ accounts, message? }`；`report:income-expense` 月视图 year 缺省 = 全表最近年份（数据为空 → 当年）；运营货币 = `ledger_meta.operating_currency[0]`，无 meta → `''`（聚合为空集）；非法 granularity / year 一律 throw

- [ ] **Step 1: 写失败测试**

`src/main/ipc-handlers-report.test.ts`（真实内存 SQLite + drizzle 直插行，模式同 `ipc-handlers.test.ts`）：

```ts
/**
 * M8-T3：report 域 handler 测试。内存 SQLite + drizzle 直插 postings/entries 行，
 * 断言 handler 聚合结果与入参校验。金额断言为精确十进制字符串。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDrizzle, openDatabase } from './db'
import { entries, ledgerMeta, postings } from './db/schema'
import { registerReportHandlers, type ReportDeps } from './ipc-handlers-report'

type Registrar = { handle: ReturnType<typeof vi.fn> }

function makeRegistrar(): Registrar {
  return { handle: vi.fn() }
}

/** 组装注册器：抽出已注册 handler，便于直接调用断言 */
function register(db: ReportDeps['db']): Map<string, (raw?: unknown) => Promise<unknown>> {
  const registrar = makeRegistrar()
  registerReportHandlers(registrar, { db })
  const handlers = new Map<string, (raw?: unknown) => Promise<unknown>>()
  for (const [channel, listener] of registrar.handle.mock.calls as Array<[string, (raw?: unknown) => Promise<unknown>]>) {
    handlers.set(channel, listener)
  }
  return handlers
}

/** 插入一条 posting（自动补 entries 行——FK on） */
function insertPosting(
  db: ReportDeps['db'],
  row: { date: string; account: string; number: string; currency: string }
): void {
  const entry = db
    .insert(entries)
    .values({ type: 'Transaction', date: row.date, narration: 't' })
    .returning()
    .get()
  db.insert(postings)
    .values({ entryId: entry.id, account: row.account, unitsNumber: row.number, unitsCurrency: row.currency })
    .run()
}

function setup(): { db: ReportDeps['db']; handlers: Map<string, (raw?: unknown) => Promise<unknown>> } {
  const db = createDrizzle(openDatabase(':memory:'))
  db.insert(ledgerMeta)
    .values({ id: 1, ledgerPath: 'x.beancount', status: 'ok', operatingCurrency: '["CNY"]' })
    .run()
  insertPosting(db, { date: '2026-01-05', account: 'Expenses:Food', number: '20.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-01-05', account: 'Liabilities:CreditCard', number: '-20.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-02-01', account: 'Assets:Bank:CNB', number: '10000.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-02-01', account: 'Income:Salary', number: '-10000.00', currency: 'CNY' })
  insertPosting(db, { date: '2026-03-10', account: 'Assets:Bank:USD', number: '100.00', currency: 'USD' })
  return { db, handlers: register(db) }
}

describe('report:net-worth', () => {
  it('month：按期间累计，仅运营货币', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:net-worth')!({ granularity: 'month' })) as {
      series: Array<{ period: string; assets: string; liabilities: string; netWorth: string }>
      currency: string
    }
    expect(r.currency).toBe('CNY')
    expect(r.series).toEqual([
      { period: '2026-01', assets: '0', liabilities: '-20', netWorth: '-20' },
      { period: '2026-02', assets: '10000', liabilities: '-20', netWorth: '9980' },
      // 2026-03 只有 USD 行（非运营货币被过滤）→ 与 2 月持平
      { period: '2026-03', assets: '10000', liabilities: '-20', netWorth: '9980' }
    ])
  })

  it('非法 granularity → throw', async () => {
    const { handlers } = setup()
    await expect(handlers.get('report:net-worth')!({ granularity: 'week' })).rejects.toThrow('granularity')
  })
})

describe('report:balances', () => {
  it('账户树 + 子树 rollup + 多币种分行', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:balances')!()) as { accounts: Array<{ name: string; balances: Array<{ currency: string; number: string }> }> }
    const assets = r.accounts.find((a) => a.name === 'Assets')!
    expect(assets.balances).toEqual([
      { currency: 'CNY', number: '10000' },
      { currency: 'USD', number: '100' }
    ])
    const liabilities = r.accounts.find((a) => a.name === 'Liabilities')!
    expect(liabilities.balances).toEqual([{ currency: 'CNY', number: '-20' }])
    const income = r.accounts.find((a) => a.name === 'Income')!
    expect(income.balances).toEqual([{ currency: 'CNY', number: '-10000' }])
  })
})

describe('report:income-expense', () => {
  it('month + year：12 个月补满，income/expense 正显示', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:income-expense')!({ granularity: 'month', year: 2026 })) as {
      series: Array<{ period: string; income: string; expense: string }>
    }
    expect(r.series).toHaveLength(12)
    const jan = r.series.find((p) => p.period === '2026-01')!
    expect(jan).toEqual({ period: '2026-01', income: '0', expense: '20' })
    const feb = r.series.find((p) => p.period === '2026-02')!
    expect(feb).toEqual({ period: '2026-02', income: '10000', expense: '0' })
  })

  it('month 缺省 year → 最近有数据的年份', async () => {
    const { handlers } = setup()
    const r = (await handlers.get('report:income-expense')!({ granularity: 'month' })) as {
      series: Array<{ period: string }>
    }
    expect(r.series.every((p) => p.period.startsWith('2026-'))).toBe(true)
  })

  it('非法 year → throw', async () => {
    const { handlers } = setup()
    await expect(
      handlers.get('report:income-expense')!({ granularity: 'month', year: 'abc' })
    ).rejects.toThrow('year')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run test:unit -- src/main/ipc-handlers-report.test.ts
```

Expected: FAIL（`Cannot find module './ipc-handlers-report'`）。

- [ ] **Step 3: 实现 ipc-handlers-report.ts**

`src/main/ipc-handlers-report.ts`：

```ts
/**
 * M8 report 域 IPC（T3）。数据源 = SQLite 索引行（SQL 只做行筛选/排序，金额聚合在
 * report-aggregation.ts 用 decimal.ts 精确字符串运算——SQLite SUM 转 REAL 丢精度，禁用）。
 * 运营货币取 ledger_meta.operating_currency[0]；无 meta → ''（聚合结果为空集）。
 */
import { asc, eq, like, or } from 'drizzle-orm'
import type { ReportBalancesResult, ReportGranularity, ReportIncomeExpenseParams, ReportIncomeExpenseResult, ReportNetWorthParams, ReportNetWorthResult } from '../shared/ipc'
import type { DrizzleDb } from './db'
import { entries, postings } from './db/schema'
import { getLedgerStatus } from './index-builder'
import { buildAccountTree, computeIncomeExpense, computeNetWorth, type PostingRow } from './report-aggregation'
import type { IpcRegistrar } from './ipc-handlers'

export interface ReportDeps {
  db: DrizzleDb
}

const YEAR_RE = /^\d{4}$/

function validateGranularity(raw: unknown, label: string): ReportGranularity {
  if (raw !== 'month' && raw !== 'year') throw new Error(`${label} 必须是 month 或 year`)
  return raw
}

function validateYear(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !YEAR_RE.test(String(raw))) {
    throw new Error('year 必须是 4 位数字年份')
  }
  return raw
}

/** 加载 postings 行（join entries 取日期，按日期升序——累计口径依赖行序） */
function loadRows(db: DrizzleDb, prefixWhere: Parameters<typeof like>[1]): PostingRow[] {
  return db
    .select({
      date: entries.date,
      account: postings.account,
      number: postings.unitsNumber,
      currency: postings.unitsCurrency
    })
    .from(postings)
    .innerJoin(entries, eq(postings.entryId, entries.id))
    .where(prefixWhere)
    .orderBy(asc(entries.date), asc(postings.id))
    .all()
}

/** 运营货币（主币）；无 meta → '' */
function operatingCurrency(db: DrizzleDb): string {
  return getLedgerStatus(db)?.operatingCurrency[0] ?? ''
}

export function registerReportHandlers(ipc: IpcRegistrar, deps: ReportDeps): void {
  const { db } = deps

  ipc.handle('report:net-worth', async (_event: unknown, raw: unknown): Promise<ReportNetWorthResult> => {
    const granularity = validateGranularity((raw as ReportNetWorthParams | undefined)?.granularity, 'granularity')
    const currency = operatingCurrency(db)
    const rows = loadRows(db, or(like(postings.account, 'Assets:%'), like(postings.account, 'Liabilities:%')))
    return { series: computeNetWorth(rows, granularity, currency), currency }
  })

  ipc.handle('report:balances', (): ReportBalancesResult => {
    const rows = loadRows(db, like(postings.account, '%'))
    return { accounts: buildAccountTree(rows) }
  })

  ipc.handle('report:income-expense', async (_event: unknown, raw: unknown): Promise<ReportIncomeExpenseResult> => {
    const params = (raw ?? {}) as ReportIncomeExpenseParams
    const granularity = validateGranularity(params.granularity, 'granularity')
    const year = validateYear(params.year)
    const currency = operatingCurrency(db)
    const rows = loadRows(db, or(like(postings.account, 'Income:%'), like(postings.account, 'Expenses:%')))
    // month 缺省 year → 最近有数据的年份（rows 为空 → 当年，12 个月全 0）
    let resolvedYear = year
    if (granularity === 'month' && resolvedYear === undefined) {
      resolvedYear = rows.reduce((acc, r) => Math.max(acc, Number(r.date.slice(0, 4))), 0)
    }
    return {
      series: computeIncomeExpense(rows, granularity, currency, resolvedYear ?? new Date().getFullYear()),
      currency
    }
  })
}
```

注意：`loadRows` 的 `where` 为 `or(...)` 表达式（`SQL<unknown>` 类型），`like(postings.account, '%')` 全量等价「不过滤」——余额树需要全部账户。若 drizzle 类型对 `or(like, like)` 报参类型不匹配，将 `loadRows` 签名改为接受 `where: SQL | undefined`，全量场景传 `undefined`（drizzle where 可省）。以 typecheck 实测为准，行为不变。

- [ ] **Step 4: 运行确认通过**

```bash
npm run test:unit -- src/main/ipc-handlers-report.test.ts
```

Expected: PASS（8 个用例全绿）。

- [ ] **Step 5: 主进程注册接线**

`src/main/index.ts`：import 追加 + 在 `registerAiHandlers` 之后、`createWindow()` 之前：

```ts
import { registerReportHandlers } from './ipc-handlers-report'
// ...
  // M8：report 域三通道（报表只读聚合，复用 M3 索引）
  registerReportHandlers(ipcMain, { db })
```

- [ ] **Step 6: 全量验证 + 提交**

```bash
npm run typecheck && npm run test:unit
```

```bash
git add src/main/ipc-handlers-report.ts src/main/ipc-handlers-report.test.ts src/main/index.ts
git commit -m "feat: report 域 IPC 三通道（SQLite 行 → decimal 精确聚合）（M8-T3）"
```

---

## Task 4（M8-T4）：reports store + ReportsView + App 接线

**Files:**
- Create: `src/renderer/src/stores/reports.ts`
- Test: `src/renderer/src/stores/reports.test.ts`
- Create: `src/renderer/src/views/ReportsView.tsx`
- Modify: `src/renderer/src/App.tsx`（view 类型 + Sider 菜单 + Content 面板 + 粒度入口）

**Interfaces:**
- Consumes: `window.beanwise.getNetWorthReport / getBalancesReport / getIncomeExpenseReport`（T1）、shared/ipc 类型（T1）、`useLedgerStore`（`stores/ledger.ts`，只读 status）
- Produces: `useReportsStore`（zustand）：`{ granularity: ReportGranularity; netWorth: NetWorthPoint[] | null; balances: AccountBalance[] | null; incomeExpense: IncomeExpensePoint[] | null; loading: boolean; error: string | null; currency: string; setGranularity(g): void; reloadAll(): Promise<void> }`
- 渲染约定：图表 y 值 `Number()` 仅显示层；余额表 `balances` 列显示 `${number} ${currency}`（多币种 ` / ` 连接）

- [ ] **Step 1: 写 store 失败测试（node 环境，mock window.beanwise——ai.test.ts 模式）**

`src/renderer/src/stores/reports.test.ts`：

```ts
/**
 * M8-T4：报表 store 测试（node 环境 mock window.beanwise，模式同 ai.test.ts）。
 * 错误吞入 state 由 UI 展示，不向上抛；粒度切换触发趋势 + 收支重载。
 */
import { beforeEach, expect, it, vi } from 'vitest'

const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useReportsStore } from './reports'

type StubApi = {
  getNetWorthReport: ReturnType<typeof vi.fn>
  getBalancesReport: ReturnType<typeof vi.fn>
  getIncomeExpenseReport: ReturnType<typeof vi.fn>
}

function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
  const api: StubApi = {
    getNetWorthReport: vi.fn().mockResolvedValue({ series: [], currency: 'CNY' }),
    getBalancesReport: vi.fn().mockResolvedValue({ accounts: [] }),
    getIncomeExpenseReport: vi.fn().mockResolvedValue({ series: [], currency: 'CNY' }),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useReportsStore.setState({ netWorth: null, balances: null, incomeExpense: null, loading: false, error: null, currency: '' })
  Object.values(message).forEach((m) => m.mockClear())
})

it('reloadAll：三面板并行加载，数据落 store', async () => {
  const api = stubBeanwise({
    getNetWorthReport: vi.fn().mockResolvedValue({ series: [{ period: '2026-01', assets: '9', liabilities: '0', netWorth: '9' }], currency: 'CNY' }),
    getBalancesReport: vi.fn().mockResolvedValue({ accounts: [{ name: 'Assets', balances: [{ currency: 'CNY', number: '9' }] }] }),
    getIncomeExpenseReport: vi.fn().mockResolvedValue({ series: [{ period: '2026-01', income: '0', expense: '9' }], currency: 'CNY' })
  })
  await useReportsStore.getState().reloadAll()
  const s = useReportsStore.getState()
  expect(s.netWorth).toHaveLength(1)
  expect(s.balances).toHaveLength(1)
  expect(s.incomeExpense).toHaveLength(1)
  expect(s.currency).toBe('CNY')
  expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'month' })
  expect(api.getIncomeExpenseReport).toHaveBeenCalledWith({ granularity: 'month' })
})

it('setGranularity：切换粒度 → 趋势与收支带新粒度重载', async () => {
  const api = stubBeanwise()
  useReportsStore.getState().setGranularity('year')
  expect(useReportsStore.getState().granularity).toBe('year')
  expect(api.getNetWorthReport).toHaveBeenCalledWith({ granularity: 'year' })
  expect(api.getIncomeExpenseReport).toHaveBeenCalledWith({ granularity: 'year' })
})

it('加载失败：error 落 store + antd 提示，不抛', async () => {
  stubBeanwise({ getNetWorthReport: vi.fn().mockRejectedValue(new Error('boom')) })
  await useReportsStore.getState().reloadAll()
  expect(useReportsStore.getState().error).toBeTruthy()
  expect(message.error).toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run test:unit -- src/renderer/src/stores/reports.test.ts
```

Expected: FAIL（`Cannot find module './reports'`）。

- [ ] **Step 3: 实现 stores/reports.ts**

```ts
/**
 * M8 报表 store（T4）：三面板独立数据 + 共享粒度/loading/error。
 * 错误吞入 state 由 UI 展示（Alert / message），不向上抛——同 ledger/ai store 约定。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint, ReportGranularity } from '../../../shared/ipc'

interface ReportsState {
  granularity: ReportGranularity
  netWorth: NetWorthPoint[] | null
  balances: AccountBalance[] | null
  incomeExpense: IncomeExpensePoint[] | null
  loading: boolean
  error: string | null
  currency: string
  setGranularity(g: ReportGranularity): void
  reloadAll(): Promise<void>
}

async function loadAll(granularity: ReportGranularity): Promise<{
  netWorth: NetWorthPoint[]
  balances: AccountBalance[]
  incomeExpense: IncomeExpensePoint[]
  currency: string
}> {
  const [nw, bal, ie] = await Promise.all([
    window.beanwise.getNetWorthReport({ granularity }),
    window.beanwise.getBalancesReport(),
    window.beanwise.getIncomeExpenseReport({ granularity })
  ])
  return { netWorth: nw.series, balances: bal.accounts, incomeExpense: ie.series, currency: nw.currency }
}

export const useReportsStore = create<ReportsState>((set, get) => ({
  granularity: 'month',
  netWorth: null,
  balances: null,
  incomeExpense: null,
  loading: false,
  error: null,
  currency: '',

  setGranularity: (g) => {
    if (g === get().granularity) return
    set({ granularity: g })
    void get().reloadAll()
  },

  reloadAll: async () => {
    set({ loading: true, error: null })
    try {
      const r = await loadAll(get().granularity)
      set({ netWorth: r.netWorth, balances: r.balances, incomeExpense: r.incomeExpense, currency: r.currency })
    } catch (err) {
      const msg = String(err)
      set({ error: msg })
      message.error(`报表加载失败：${msg}`)
    } finally {
      set({ loading: false })
    }
  }
}))
```

- [ ] **Step 4: 运行确认通过**

```bash
npm run test:unit -- src/renderer/src/stores/reports.test.ts
```

Expected: PASS（3 个用例全绿）。

- [ ] **Step 5: 实现 views/ReportsView.tsx**

```tsx
/**
 * M8 报表视图（T4）：粒度 Segmented + 三面板（净资产趋势 Line / 收支对比 Column /
 * 账户余额树表格）。图表 y 值 Number() 仅显示层，精确金额由余额表十进制字符串提供。
 */
import { Column, Line } from '@ant-design/charts'
import { Alert, Card, Empty, Segmented, Spin, Table, Typography } from 'antd'
import { useEffect } from 'react'
import type { AccountBalance, IncomeExpensePoint, NetWorthPoint } from '../../../shared/ipc'
import { useLedgerStore } from '../stores/ledger'
import { useReportsStore } from '../stores/reports'

/** 趋势点 → 图数据（三序列展开） */
function toTrendSeries(points: NetWorthPoint[]): Array<{ period: string; series: string; value: number }> {
  return points.flatMap((p) => [
    { period: p.period, series: '资产', value: Number(p.assets) },
    { period: p.period, series: '负债', value: Number(p.liabilities) },
    { period: p.period, series: '净资产', value: Number(p.netWorth) }
  ])
}

/** 收支点 → 图数据（收入/支出两序列展开） */
function toIncomeExpenseSeries(points: IncomeExpensePoint[]): Array<{ period: string; type: string; value: number }> {
  return points.flatMap((p) => [
    { period: p.period, type: '收入', value: Number(p.income) },
    { period: p.period, type: '支出', value: Number(p.expense) }
  ])
}

function BalanceCell({ balances }: { balances: Array<{ currency: string; number: string }> }) {
  return (
    <span>{balances.map((b) => `${b.number} ${b.currency}`).join(' / ') || '—'}</span>
  )
}

export default function ReportsView() {
  const granularity = useReportsStore((s) => s.granularity)
  const setGranularity = useReportsStore((s) => s.setGranularity)
  const netWorth = useReportsStore((s) => s.netWorth)
  const balances = useReportsStore((s) => s.balances)
  const incomeExpense = useReportsStore((s) => s.incomeExpense)
  const loading = useReportsStore((s) => s.loading)
  const error = useReportsStore((s) => s.error)
  const currency = useReportsStore((s) => s.currency)
  const status = useLedgerStore((s) => s.status)

  useEffect(() => {
    void useReportsStore.getState().reloadAll()
  }, [])

  const hasData = (netWorth?.length ?? 0) > 0 || (incomeExpense?.length ?? 0) > 0 || (balances?.length ?? 0) > 0

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Segmented
          value={granularity}
          onChange={(v) => setGranularity(v as 'month' | 'year')}
          options={[
            { label: '月', value: 'month' },
            { label: '年', value: 'year' }
          ]}
        />
        {currency && <Typography.Text type="secondary">运营货币：{currency}</Typography.Text>}
      </div>

      {status && status.status !== 'ok' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="索引异常，数据可能不完整，请先重建索引"
          description={status.lastError ?? undefined}
        />
      )}
      {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error} />}

      <Spin spinning={loading}>
        {hasData ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Card title="净资产趋势" style={{ gridColumn: '1 / -1' }}>
              <Line
                data={toTrendSeries(netWorth ?? [])}
                xField="period"
                yField="value"
                colorField="series"
                height={280}
              />
            </Card>
            <Card title="收支对比">
              <Column
                data={toIncomeExpenseSeries(incomeExpense ?? [])}
                xField="period"
                yField="value"
                colorField="type"
                height={280}
              />
            </Card>
            <Card title="账户余额">
              <Table<AccountBalance>
                dataSource={balances ?? []}
                rowKey="name"
                pagination={false}
                expandable={{ defaultExpandAllRows: true }}
                columns={[
                  { title: '账户', dataIndex: 'name' },
                  { title: '余额', dataIndex: 'balances', render: (b: Array<{ currency: string; number: string }>) => <BalanceCell balances={b} /> }
                ]}
              />
            </Card>
          </div>
        ) : (
          <Empty description="暂无数据，请先录入账目" />
        )}
      </Spin>
    </div>
  )
}
```

- [ ] **Step 6: App.tsx 接线（菜单 + 面板 + 类型扩展）**

`src/renderer/src/App.tsx`：

```tsx
import { BarChartOutlined, CloudOutlined, FileTextOutlined, FormOutlined, UnorderedListOutlined } from '@ant-design/icons'
// ...
import ReportsView from './views/ReportsView'

// view 状态类型扩展
const [view, setView] = useState<'entry' | 'entries' | 'editor' | 'conflict' | 'reports'>('entry')

// Sider Menu items 追加（「明细」之后）：
{ key: 'reports', icon: <BarChartOutlined />, label: '报表' },

// onClick 类型断言同步扩展：
onClick={({ key }) => setView(key as 'entry' | 'entries' | 'editor' | 'conflict' | 'reports')}

// Content 追加面板（编辑器之后）：
<div style={{ display: view === 'reports' ? 'block' : 'none' }}><ReportsView /></div>
```

- [ ] **Step 7: 全量验证 + 提交**

```bash
npm run typecheck && npm run test:unit
```

```bash
git add src/renderer/src/stores/reports.ts src/renderer/src/stores/reports.test.ts src/renderer/src/views/ReportsView.tsx src/renderer/src/App.tsx
git commit -m "feat: 报表视图（净资产趋势/收支对比/余额树）+ reports store（M8-T4）"
```

---

## Task 5（M8-T5）：updater 状态机服务（TDD，注入式依赖）

**Files:**
- Create: `src/main/updater.ts`
- Test: `src/main/updater.test.ts`

**Interfaces:**
- Consumes: `UpdateState` / `UpdateStatus`（shared/ipc，T1）
- Produces: `UpdaterLike`（注入抽象：`on` / `setFeedURL` / `checkForUpdates` / `quitAndInstall` / `forceDevUpdateConfig?`）、`UpdaterService { state(): UpdateState; check(): Promise<void>; install(): void; onChanged(cb: (state: UpdateState) => void): () => void }`、`createUpdaterService(deps: { updater: UpdaterLike; currentVersion: string; feedUrl?: string }): UpdaterService`
- 事件映射：`checking-for-update`→checking、`update-available(info)`→available + availableVersion、`update-not-available`→idle、`download-progress(p)`→downloading + progress(四舍五入整数)、`update-downloaded`→downloaded、`error(e)`→error + message；`check()` 失败 catch → error；feedUrl 提供时 `forceDevUpdateConfig = true` + `setFeedURL({ provider: 'generic', url })`；`install()` = `quitAndInstall()`

- [ ] **Step 1: 写失败测试**

`src/main/updater.test.ts`（FakeUpdater 注入，无需 vi.mock——TDD 目标：状态机映射正确）：

```ts
/**
 * M8-T5：updater 状态机测试。FakeUpdater（EventEmitter）注入，驱动事件断言状态流转；
 * 真实 autoUpdater 由 main/index.ts 组装时注入（生产走 app-update.yml，E2E 走 BEANWISE_UPDATE_FEED_URL）。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUpdaterService, type UpdaterLike } from './updater'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  forceDevUpdateConfig?: boolean
  setFeedURL = vi.fn()
  checkForUpdates = vi.fn().mockResolvedValue(undefined)
  quitAndInstall = vi.fn()
}

function setup(feedUrl?: string): { fake: FakeUpdater; service: ReturnType<typeof createUpdaterService> } {
  const fake = new FakeUpdater()
  const service = createUpdaterService({ updater: fake, currentVersion: '0.1.0', feedUrl })
  return { fake, service }
}

describe('createUpdaterService', () => {
  it('初始状态：idle + 当前版本', () => {
    const { service } = setup()
    expect(service.state()).toEqual({ status: 'idle', currentVersion: '0.1.0' })
  })

  it('feedUrl 注入：forceDevUpdateConfig + setFeedURL(generic)', () => {
    const { fake } = setup('http://127.0.0.1:9999')
    expect(fake.forceDevUpdateConfig).toBe(true)
    expect(fake.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:9999' })
  })

  it('无 feedUrl：不调 setFeedURL（生产走 app-update.yml）', () => {
    const { fake } = setup()
    expect(fake.setFeedURL).not.toHaveBeenCalled()
  })

  it('事件流：checking → available → downloading → downloaded，onChanged 逐次推送', async () => {
    const { fake, service } = setup()
    const changes: string[] = []
    service.onChanged((s) => changes.push(s.status))
    await service.check()
    expect(changes).toEqual(['checking'])
    fake.emit('update-available', { version: '9.9.9' })
    expect(service.state().status).toBe('available')
    expect(service.state().availableVersion).toBe('9.9.9')
    fake.emit('download-progress', { percent: 12.6 })
    expect(service.state().status).toBe('downloading')
    expect(service.state().progress).toBe(13)
    fake.emit('update-downloaded', { version: '9.9.9' })
    expect(service.state().status).toBe('downloaded')
    expect(changes).toEqual(['checking', 'available', 'downloading', 'downloaded'])
  })

  it('update-not-available → 回到 idle，无 availableVersion', () => {
    const { fake, service } = setup()
    void service.check()
    fake.emit('update-available', { version: '9.9.9' })
    fake.emit('update-not-available')
    expect(service.state().status).toBe('idle')
    expect(service.state().availableVersion).toBeUndefined()
  })

  it('error 事件 → error 状态 + 中文信息', () => {
    const { fake, service } = setup()
    fake.emit('error', new Error('network down'))
    expect(service.state().status).toBe('error')
    expect(service.state().error).toBe('network down')
  })

  it('check() 异常 → catch 落 error 状态', async () => {
    const fake = new FakeUpdater()
    fake.checkForUpdates = vi.fn().mockRejectedValue(new Error('check failed'))
    const service = createUpdaterService({ updater: fake, currentVersion: '0.1.0' })
    await service.check()
    expect(service.state().status).toBe('error')
    expect(service.state().error).toBe('check failed')
  })

  it('install() → quitAndInstall', () => {
    const { fake, service } = setup()
    service.install()
    expect(fake.quitAndInstall).toHaveBeenCalled()
  })

  it('onChanged 返回取消订阅函数', () => {
    const { fake, service } = setup()
    const changes: string[] = []
    const off = service.onChanged((s) => changes.push(s.status))
    off()
    fake.emit('update-available', { version: '9.9.9' })
    expect(changes).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run test:unit -- src/main/updater.test.ts
```

Expected: FAIL（`Cannot find module './updater'`）。

- [ ] **Step 3: 实现 src/main/updater.ts**

```ts
/**
 * M8 updater 状态机（T5）：封装 electron-updater，事件 → UpdateState 单向映射。
 * autoUpdater 注入式（单测传 FakeUpdater；生产传 electron-updater 单例 autoUpdater）。
 * feedUrl 注入（BEANWISE_UPDATE_FEED_URL，测试/E2E）→ forceDevUpdateConfig + setFeedURL(generic)；
 * 生产无 feedUrl → 走 electron-builder 生成的 app-update.yml（provider github）。
 */
import type { UpdateState, UpdateStatus } from '../shared/ipc'

/** autoUpdater 注入抽象（electron-updater 的 AutoUpdater 是 EventEmitter 子类，结构兼容） */
export interface UpdaterLike {
  forceDevUpdateConfig?: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  setFeedURL(options: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<unknown> | void
  quitAndInstall(): void
}

export interface UpdaterService {
  state(): UpdateState
  /** 触发检查；异常自行 catch 落 error 状态，不向上抛 */
  check(): Promise<void>
  install(): void
  /** 状态变更订阅，返回取消订阅函数 */
  onChanged(cb: (state: UpdateState) => void): () => void
}

export function createUpdaterService(deps: {
  updater: UpdaterLike
  currentVersion: string
  feedUrl?: string
}): UpdaterService {
  const { updater } = deps
  const listeners = new Set<(state: UpdateState) => void>()
  let state: UpdateState = { status: 'idle', currentVersion: deps.currentVersion }

  function setStatus(status: UpdateStatus, patch: Partial<UpdateState> = {}): void {
    state = { ...state, status, ...patch }
    listeners.forEach((cb) => cb(state))
  }

  if (deps.feedUrl) {
    // 测试/E2E：dev 模式无 app-update.yml，编程注入 generic 更新源
    updater.forceDevUpdateConfig = true
    updater.setFeedURL({ provider: 'generic', url: deps.feedUrl })
  }

  updater.on('checking-for-update', () => setStatus('checking'))
  updater.on('update-available', (info: { version?: string }) => {
    setStatus('available', { availableVersion: info?.version })
  })
  updater.on('update-not-available', () => setStatus('idle', { availableVersion: undefined, progress: undefined }))
  updater.on('download-progress', (p: { percent?: number }) => {
    setStatus('downloading', { progress: Math.round(p?.percent ?? 0) })
  })
  updater.on('update-downloaded', () => setStatus('downloaded'))
  updater.on('error', (err: unknown) => {
    setStatus('error', { error: err instanceof Error ? err.message : String(err) })
  })

  return {
    state: () => state,
    check: async () => {
      setStatus('checking')
      try {
        await updater.checkForUpdates()
      } catch (err) {
        setStatus('error', { error: err instanceof Error ? err.message : String(err) })
      }
    },
    install: () => {
      updater.quitAndInstall()
    },
    onChanged: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm run test:unit -- src/main/updater.test.ts
```

Expected: PASS（9 个用例全绿）。

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run typecheck && npm run test:unit
```

```bash
git add src/main/updater.ts src/main/updater.test.ts
git commit -m "feat: updater 状态机（electron-updater 封装，事件→状态单向映射）（M8-T5）"
```

---

## Task 6（M8-T6）：update IPC handlers + update store + UpdateModal + App 接线

**Files:**
- Create: `src/main/ipc-handlers-update.ts`
- Test: `src/main/ipc-handlers-update.test.ts`
- Modify: `src/main/index.ts`（autoUpdater 组装 + 注册 + broadcast 接线）
- Create: `src/renderer/src/stores/update.ts`
- Test: `src/renderer/src/stores/update.test.ts`
- Create: `src/renderer/src/views/UpdateModal.tsx`
- Modify: `src/renderer/src/App.tsx`（Header「更新」按钮 + Modal + init 订阅）

**Interfaces:**
- Consumes: `UpdaterService`（T5）、`UPDATE_STATUS_CHANNEL`（T1）、`IpcRegistrar`
- Produces: `registerUpdateHandlers(ipc: IpcRegistrar, deps: { updater: UpdaterService; broadcast: (state: UpdateState) => void }): void`；`useUpdateStore`：`{ state: UpdateState | null; init(): Promise<void>; check(): Promise<void>; install(): void }`（init 同时订阅 `onUpdateStatusChanged` 推送）

- [ ] **Step 1: 写 handler 失败测试**

`src/main/ipc-handlers-update.test.ts`：

```ts
/**
 * M8-T6：update 域 handler 测试。mock UpdaterService + broadcast，断言三通道行为。
 */
import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../shared/ipc'
import { registerUpdateHandlers, type UpdaterServiceLike } from './ipc-handlers-update'

type Registrar = { handle: ReturnType<typeof vi.fn> }

function setup(): {
  registrar: Registrar
  updater: UpdaterServiceLike
  broadcast: ReturnType<typeof vi.fn>
} {
  const registrar = { handle: vi.fn() }
  const updater: UpdaterServiceLike = {
    state: vi.fn().mockReturnValue({ status: 'idle', currentVersion: '0.1.0' } satisfies UpdateState),
    check: vi.fn().mockResolvedValue(undefined),
    install: vi.fn(),
    onChanged: vi.fn().mockReturnValue(() => {})
  }
  const broadcast = vi.fn()
  registerUpdateHandlers(registrar, { updater, broadcast })
  return { registrar, updater, broadcast }
}

function handler(registrar: Registrar, channel: string): (...args: unknown[]) => Promise<unknown> {
  const entry = registrar.handle.mock.calls.find((c) => c[0] === channel) as [string, (...args: unknown[]) => Promise<unknown>]
  return entry[1]
}

describe('registerUpdateHandlers', () => {
  it('注册三通道 + 状态推送接线（onChanged → broadcast）', () => {
    const { registrar, updater, broadcast } = setup()
    expect(registrar.handle.mock.calls.map((c) => c[0])).toEqual(['update:check', 'update:status', 'update:install'])
    // 接线断言：register 内调 updater.onChanged(broadcast) → 捕获回调并触发 → broadcast 收到
    expect(updater.onChanged).toHaveBeenCalledWith(expect.any(Function))
    const [cb] = updater.onChanged.mock.calls[0] as [(s: UpdateState) => void]
    cb({ status: 'downloaded', currentVersion: '0.1.0' })
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloaded' }))
  })

  it('update:check：成功 → { ok: true }', async () => {
    const { registrar } = setup()
    const r = await handler(registrar, 'update:check')()
    expect(r).toEqual({ ok: true })
  })

  it('update:check：异常 → { ok: false, message }（check 自身 catch，此处防御）', async () => {
    const { registrar, updater } = setup()
    updater.check = vi.fn().mockRejectedValue(new Error('boom'))
    const r = await handler(registrar, 'update:check')()
    expect(r).toEqual({ ok: false, message: 'boom' })
  })

  it('update:status → 当前状态', async () => {
    const { registrar } = setup()
    const r = await handler(registrar, 'update:status')()
    expect(r).toEqual({ status: 'idle', currentVersion: '0.1.0' })
  })

  it('update:install → { ok: true } 且触发 install', async () => {
    const { registrar, updater } = setup()
    const r = await handler(registrar, 'update:install')()
    expect(r).toEqual({ ok: true })
    expect(updater.install).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run test:unit -- src/main/ipc-handlers-update.test.ts
```

Expected: FAIL（`Cannot find module './ipc-handlers-update'`）。

- [ ] **Step 3: 实现 src/main/ipc-handlers-update.ts**

```ts
/**
 * M8 update 域 IPC（T6）：三通道 + 状态推送接线（updater 变化 → broadcast →
 * webContents.send(UPDATE_STATUS_CHANNEL)）。渲染端经 preload onUpdateStatusChanged 订阅。
 */
import type { UpdateCheckResult, UpdateInstallResult, UpdateState } from '../shared/ipc'
import type { UpdaterService } from './updater'
import type { IpcRegistrar } from './ipc-handlers'

/** handler 依赖：UpdaterService 的子集（单测 mock 用） */
export interface UpdaterServiceLike {
  state(): UpdateState
  check(): Promise<void>
  install(): void
  onChanged(cb: (state: UpdateState) => void): () => void
}

export function registerUpdateHandlers(
  ipc: IpcRegistrar,
  deps: { updater: UpdaterServiceLike; broadcast: (state: UpdateState) => void }
): void {
  const { updater, broadcast } = deps
  updater.onChanged(broadcast)

  ipc.handle('update:check', async (): Promise<UpdateCheckResult> => {
    try {
      await updater.check()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipc.handle('update:status', (): UpdateState => updater.state())

  ipc.handle('update:install', (): UpdateInstallResult => {
    updater.install()
    return { ok: true }
  })
}
```

- [ ] **Step 4: 运行确认通过**

```bash
npm run test:unit -- src/main/ipc-handlers-update.test.ts
```

Expected: PASS（5 个用例全绿；Step 1 的接线用例按注释口径微调）。

- [ ] **Step 5: 主进程组装接线**

`src/main/index.ts`：

```ts
import { autoUpdater } from 'electron-updater'
import { UPDATE_STATUS_CHANNEL, type UpdateState } from '../shared/ipc'
import { registerUpdateHandlers } from './ipc-handlers-update'
import { createUpdaterService } from './updater'
// ...在 registerAiHandlers 之后：
  // M8：update 域三通道。autoUpdater 注入（状态机封装）；BEANWISE_UPDATE_FEED_URL
  // 为测试/E2E 注入 mock 更新源（setFeedURL + forceDevUpdateConfig）；生产走 app-update.yml
  const updater = createUpdaterService({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    feedUrl: process.env['BEANWISE_UPDATE_FEED_URL']
  })
  registerUpdateHandlers(ipcMain, {
    updater,
    broadcast: (s: UpdateState) => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(UPDATE_STATUS_CHANNEL, s))
    }
  })
```

- [ ] **Step 6: 写 update store 失败测试**

`src/renderer/src/stores/update.test.ts`：

```ts
/**
 * M8-T6：update store 测试（node 环境 mock window.beanwise，模式同 ai.test.ts）。
 * init：拉初始状态 + 订阅事件推送；check/install 透传 window.beanwise。
 */
import { beforeEach, expect, it, vi } from 'vitest'

const { message } = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('antd', () => ({ message }))

import { useUpdateStore } from './update'

type StubApi = {
  getUpdateStatus: ReturnType<typeof vi.fn>
  checkForUpdates: ReturnType<typeof vi.fn>
  installUpdate: ReturnType<typeof vi.fn>
  onUpdateStatusChanged: ReturnType<typeof vi.fn>
}

function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
  const api: StubApi = {
    getUpdateStatus: vi.fn().mockResolvedValue({ status: 'idle', currentVersion: '0.1.0' }),
    checkForUpdates: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: true }),
    onUpdateStatusChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides
  }
  vi.stubGlobal('window', { beanwise: api })
  return api
}

beforeEach(() => {
  vi.unstubAllGlobals()
  useUpdateStore.setState({ state: null })
  Object.values(message).forEach((m) => m.mockClear())
})

it('init：拉初始状态 + 订阅推送（事件回调落 store）', async () => {
  const api = stubBeanwise()
  await useUpdateStore.getState().init()
  expect(useUpdateStore.getState().state).toEqual({ status: 'idle', currentVersion: '0.1.0' })
  expect(api.onUpdateStatusChanged).toHaveBeenCalled()
  // 触发订阅回调 → store 更新（模拟 main → renderer 推送）
  const [cb] = api.onUpdateStatusChanged.mock.calls[0] as [(s: { status: string; currentVersion: string }) => void]
  cb({ status: 'downloaded', currentVersion: '0.1.0' })
  expect(useUpdateStore.getState().state?.status).toBe('downloaded')
})

it('check：透传 beanwise，成功返回 true', async () => {
  const api = stubBeanwise()
  const ok = await useUpdateStore.getState().check()
  expect(ok).toBe(true)
  expect(api.checkForUpdates).toHaveBeenCalled()
})

it('check：失败 → message.error 提示', async () => {
  stubBeanwise({ checkForUpdates: vi.fn().mockResolvedValue({ ok: false, message: '网络错误' }) })
  const ok = await useUpdateStore.getState().check()
  expect(ok).toBe(false)
  expect(message.error).toHaveBeenCalled()
})

it('install：透传 beanwise', async () => {
  const api = stubBeanwise()
  await useUpdateStore.getState().install()
  expect(api.installUpdate).toHaveBeenCalled()
})
```

- [ ] **Step 7: 运行确认失败 → 实现 stores/update.ts**

```bash
npm run test:unit -- src/renderer/src/stores/update.test.ts
```

`src/renderer/src/stores/update.ts`：

```ts
/**
 * M8 更新 store（T6）：状态 = window.beanwise.getUpdateStatus() 初始拉取 +
 * onUpdateStatusChanged 事件推送（main → renderer）。check 失败提示不抛。
 */
import { message } from 'antd'
import { create } from 'zustand'
import type { UpdateState } from '../../../shared/ipc'

interface UpdateStoreState {
  state: UpdateState | null
  init(): Promise<void>
  check(): Promise<boolean>
  install(): Promise<void>
}

let unsubscribed = false

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  state: null,

  init: async () => {
    try {
      const state = await window.beanwise.getUpdateStatus()
      set({ state })
    } catch (err) {
      set({ state: { status: 'error', currentVersion: '', error: String(err) } })
    }
    // 事件推送订阅（main → renderer）；幂等：仅订阅一次
    if (!unsubscribed) {
      unsubscribed = true
      window.beanwise.onUpdateStatusChanged((state) => set({ state }))
    }
  },

  check: async () => {
    try {
      const r = await window.beanwise.checkForUpdates()
      if (!r.ok) {
        message.error(`检查更新失败：${r.message ?? '未知错误'}`)
        return false
      }
      return true
    } catch (err) {
      message.error(`检查更新失败：${String(err)}`)
      return false
    }
  },

  install: async () => {
    try {
      await window.beanwise.installUpdate()
    } catch (err) {
      message.error(`安装失败：${String(err)}`)
    }
  }
}))
```

- [ ] **Step 8: 运行确认通过**

```bash
npm run test:unit -- src/renderer/src/stores/update.test.ts
```

Expected: PASS（4 个用例全绿）。

- [ ] **Step 9: 实现 views/UpdateModal.tsx**

```tsx
/**
 * M8 更新 Modal（T6）：当前版本 + 检查更新 + 下载进度 + 错误态 + 安装按钮。
 * 状态来自 update store（初始拉取 + 事件推送）。沿用 AiSettingsModal Modal 模式。
 */
import { Alert, Button, Modal, Progress, Space, Typography } from 'antd'
import { useUpdateStore } from '../stores/update'

export default function UpdateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useUpdateStore((s) => s.state)
  const check = useUpdateStore((s) => s.check)
  const install = useUpdateStore((s) => s.install)

  const checking = state?.status === 'checking'
  const downloading = state?.status === 'downloading'

  return (
    <Modal title="更新" open={open} onCancel={onClose} footer={null} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text>当前版本：v{state?.currentVersion ?? '—'}</Typography.Text>
        {state?.status === 'available' && state.availableVersion && (
          <Typography.Text type="warning">发现新版本 v{state.availableVersion}</Typography.Text>
        )}
        {state?.status === 'downloaded' && (
          <Space>
            <Typography.Text type="success">下载完成，安装后将重启应用</Typography.Text>
            <Button type="primary" onClick={() => void install()}>立即安装</Button>
          </Space>
        )}
        {downloading && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>正在下载…</Typography.Text>
            <Progress percent={state?.progress ?? 0} />
          </Space>
        )}
        {state?.status === 'idle' && <Typography.Text type="secondary">已是最新版本</Typography.Text>}
        {state?.status === 'error' && <Alert type="error" showIcon message={`更新失败：${state?.error ?? ''}`} />}
        <Button type="primary" disabled={checking || downloading} loading={checking} onClick={() => void check()}>
          检查更新
        </Button>
      </Space>
    </Modal>
  )
}
```

- [ ] **Step 10: App.tsx 接线**

`src/renderer/src/App.tsx`：import `UpgradeOutlined` 与 `UpdateModal` / `useUpdateStore`；Header 右侧 Space 追加按钮（AI 设置旁）：

```tsx
import { useUpdateStore } from './stores/update'
import UpdateModal from './views/UpdateModal'
// 组件内：
const [updateOpen, setUpdateOpen] = useState(false)
useEffect(() => { void useUpdateStore.getState().init() }, [])
// Header Space 内（AI 设置按钮旁）：
<Button onClick={() => setUpdateOpen(true)}>更新</Button>
// 底部（AiSettingsModal 旁）：
<UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} />
```

- [ ] **Step 11: 全量验证 + 提交**

```bash
npm run typecheck && npm run test:unit
```

```bash
git add src/main/ipc-handlers-update.ts src/main/ipc-handlers-update.test.ts src/main/index.ts src/renderer/src/stores/update.ts src/renderer/src/stores/update.test.ts src/renderer/src/views/UpdateModal.tsx src/renderer/src/App.tsx
git commit -m "feat: 更新链路（update 域 IPC + store + UpdateModal）（M8-T6）"
```

---

## Task 7（M8-T7）：mock 更新源服务器 + E2E 升级演练（绿灯「升级演练」）

**Files:**
- Create: `src/main/update-test-server.ts`
- Create: `e2e/fixtures/update.ts`（薄 re-export，模式同 `e2e/fixtures/ai.ts`）
- Create: `e2e/update.spec.ts`

**Interfaces:**
- Produces: `startUpdateServer(): Promise<UpdateServer>`，`UpdateServer { url: string; close(): Promise<void> }`
- 服务器行为：`GET /latest.yml` 返回版本 `9.9.9` 的 generic provider 元数据（**同时声明 `.exe` 与 `.AppImage` 两条文件**——CI ubuntu 走 AppImageUpdater、Windows 走 NsisUpdater）；`GET /BeanWise-Setup-9.9.9.exe` / `GET /BeanWise-9.9.9.AppImage` 返回确定性字节（sha512 与 latest.yml 一致，base64 编码）
- E2E 前提：T5/T6 完成（`BEANWISE_UPDATE_FEED_URL` 注入 → setFeedURL）；断言到 `downloaded` 止，不点安装

- [ ] **Step 1: 实现 src/main/update-test-server.ts**

```ts
/**
 * M8 测试基础设施：进程内 electron-updater generic 更新源 mock（零网络零发布成本）。
 * 与 git-test-server / ai-test-server 同策略：独立非 test 模块，E2E 共用单一实现。
 * latest.yml 同时声明 .exe（Windows/NsisUpdater）与 .AppImage（CI ubuntu/AppImageUpdater）
 * 两条文件——断言状态流转与平台无关；sha512 = 服务内容字节的 base64 摘要（updater 会校验）。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const MOCK_VERSION = '9.9.9'
const EXE_NAME = 'BeanWise-Setup-9.9.9.exe'
const APPIMAGE_NAME = 'BeanWise-9.9.9.AppImage'

const EXE_BYTES = Buffer.alloc(1024, 0x5a) // 确定性假安装包字节
const APPIMAGE_BYTES = Buffer.alloc(2048, 0x41)

function b64sha512(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

/** latest.yml（electron-builder generic provider 元数据格式） */
function latestYml(): string {
  const exe = `  - url: ${EXE_NAME}\n    sha512: ${b64sha512(EXE_BYTES)}\n    size: ${EXE_BYTES.length}`
  const appimage = `  - url: ${APPIMAGE_NAME}\n    sha512: ${b64sha512(APPIMAGE_BYTES)}\n    size: ${APPIMAGE_BYTES.length}`
  return `version: ${MOCK_VERSION}\nfiles:\n${exe}\n${appimage}\npath: ${EXE_NAME}\nsha512: ${b64sha512(EXE_BYTES)}\nreleaseDate: '2026-08-11T00:00:00.000Z'\n`
}

export interface UpdateServer {
  url: string
  close(): Promise<void>
}

export async function startUpdateServer(): Promise<UpdateServer> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/latest.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' })
      res.end(latestYml())
      return
    }
    if (path === `/${EXE_NAME}`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(EXE_BYTES.length) })
      res.end(EXE_BYTES)
      return
    }
    if (path === `/${APPIMAGE_NAME}`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(APPIMAGE_BYTES.length) })
      res.end(APPIMAGE_BYTES)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}
```

- [ ] **Step 2: fixture 薄 re-export**

`e2e/fixtures/update.ts`：

```ts
/** M8 E2E 工具（薄 re-export，单一实现——ai/sync fixture 同模式） */
export { startUpdateServer } from '../../src/main/update-test-server'
export type { UpdateServer } from '../../src/main/update-test-server'
```

- [ ] **Step 3: 写 E2E 升级演练**

`e2e/update.spec.ts`：

```ts
/**
 * M8 E2E（T7）：升级演练（绿灯「升级演练」）——BEANWISE_UPDATE_FEED_URL 注入
 * 进程内 mock 更新源 → Header「更新」→ Modal「检查更新」→ 发现新版本 9.9.9 → 下载完成。
 * 断言到 downloaded 为止，不触发安装（quitAndInstall 会替换运行中的应用，安装环节留首版人工演练）。
 *
 * 环境事实（同 ai-entry.spec.ts）：antd Button autoInsertSpaceInButton——两字中文按钮
 * 可访问名含空格，「更新」以 /更\s*新/ 匹配；App.tsx 多视图常驻挂载，Modal 内容作用域
 * .ant-modal-body。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { startUpdateServer } from './fixtures/update'
import { createFixtureCopy, cleanupFixture } from './fixtures/setup'

const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

test('M8 升级演练：检查到新版本 → 下载 → downloaded', async () => {
  test.setTimeout(180_000)
  const update = await startUpdateServer()
  const ledgerPath = createFixtureCopy()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath, BEANWISE_UPDATE_FEED_URL: update.url }
    })
    const win = await app.firstWindow()

    await win.getByRole('button', { name: /更\s*新/ }).click()
    await expect(win.locator('.ant-modal-body')).toContainText('当前版本：v0.1.0')
    await win.getByRole('button', { name: /检查更新/ }).click()

    // 发现新版本（mock 源 9.9.9 > 0.1.0）
    await expect(win.locator('.ant-modal-body')).toContainText('发现新版本 v9.9.9', { timeout: 60_000 })
    // 下载完成（本地 mock 源，秒级）
    await expect(win.locator('.ant-modal-body')).toContainText('下载完成', { timeout: 120_000 })
    // 不触发安装：断言「立即安装」按钮存在但不点击
    await expect(win.getByRole('button', { name: /立即安装/ })).toBeVisible()

    await app.close()
  } finally {
    cleanupFixture(ledgerPath)
    await update.close()
  }
})
```

- [ ] **Step 4: 本机 E2E 验证**

```bash
env -u ELECTRON_RUN_AS_NODE npm run build && env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/update.spec.ts
```

Expected: PASS（本机 Windows 走 NsisUpdater 路径）。若 dev 模式 electron-updater 报「无更新渠道/无法定位 app-update.yml」类错误，检查 `createUpdaterService` 的 `feedUrl` 注入是否生效（`forceDevUpdateConfig = true` 必须设置在 `checkForUpdates()` 之前）——已按此顺序实现，如仍有差异以实测日志修正。

- [ ] **Step 5: 提交**

```bash
git add src/main/update-test-server.ts e2e/fixtures/update.ts e2e/update.spec.ts
git commit -m "test: E2E 升级演练（mock 更新源：检查→下载→downloaded）（M8-T7）"
```

---

## Task 8（M8-T8）：报表 E2E（绿灯「图表渲染真实数据」）

**Files:**
- Create: `python/tests/fixtures/reports.beancount`（跨年跨月多账户测试账本）
- Create: `e2e/reports.spec.ts`

**Interfaces:**
- Consumes: T2/T3/T4 全部产物
- E2E 断言口径（Global Constraints 偏差②）：IPC 返回数据（真实数据链路）+ UI 无错误 + 余额表精确文本；图表 canvas 文本不可 DOM 断言，仅断言容器存在

- [ ] **Step 1: 写报表测试账本 fixture**

`python/tests/fixtures/reports.beancount`：

```beancount
option "title" "Reports Test Ledger"
option "operating_currency" "CNY"

2025-01-01 open Assets:Bank:CNB
2025-01-01 open Liabilities:CreditCard
2025-01-01 open Income:Salary
2025-01-01 open Expenses:Food
2025-01-01 open Expenses:Transport

2025-03-01 * "Salary"
  Assets:Bank:CNB  10000.00 CNY
  Income:Salary  -10000.00 CNY

2025-03-05 * "Ramen"
  Expenses:Food  35.00 CNY
  Assets:Bank:CNB  -35.00 CNY

2025-06-10 * "Metro"
  Expenses:Transport  5.00 CNY
  Assets:Bank:CNB  -5.00 CNY

2026-01-05 * "Coffee"
  Expenses:Food  20.00 CNY
  Liabilities:CreditCard  -20.00 CNY

2026-02-01 * "Salary"
  Assets:Bank:CNB  10000.00 CNY
  Income:Salary  -10000.00 CNY
```

预期聚合值（decimal 精确口径，T2 同款演算）：净资产月趋势 2026-01 = assets 9960 / liabilities -20 / netWorth 9940；2026-02 = assets 19960 / liabilities -20 / netWorth 19940；收支 2026 年 = income 10000（2026-02 工资）/ expense 20；余额树 Assets:Bank:CNB = 19960 CNY，Liabilities:CreditCard = -20 CNY。

- [ ] **Step 2: 写 E2E**

`e2e/reports.spec.ts`：

```ts
/**
 * M8 E2E（T8）：报表视图绿灯——真实账本数据（reports.beancount 副本）→
 * IPC 返回精确聚合（decimal 字符串）+ UI 渲染无错误 + 余额表精确文本 + 图表容器存在。
 * 断言口径：canvas 文本不可 DOM 断言，以 IPC 数据 + 表格文本为准（Global Constraints 偏差②）。
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

/** reports.beancount 副本（临时目录） */
function createReportsFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beanwise-reports-'))
  copyFileSync(resolve('python/tests/fixtures/reports.beancount'), join(dir, 'main.beancount'))
  return join(dir, 'main.beancount')
}

test('M8 报表：真实数据渲染（IPC 聚合 + 余额表 + 图表容器）', async () => {
  test.setTimeout(120_000)
  const ledgerPath = createReportsFixture()
  try {
    const app = await electron.launch({
      args: launchArgs,
      env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
    })
    const win = await app.firstWindow()

    // 1. IPC 真实数据链路：净资产月趋势（期末累计，decimal 精确字符串）
    const nw = await win.evaluate(() => window.beanwise.getNetWorthReport({ granularity: 'month' }))
    expect(nw.currency).toBe('CNY')
    const jan = nw.series.find((p) => p.period === '2026-01')
    expect(jan).toEqual({ period: '2026-01', assets: '9960', liabilities: '-20', netWorth: '9940' })

    // 2. IPC：余额树 rollup
    const bal = await win.evaluate(() => window.beanwise.getBalancesReport())
    const assets = bal.accounts.find((a) => a.name === 'Assets')
    expect(assets?.balances).toEqual([{ currency: 'CNY', number: '19960' }])

    // 3. IPC：收支对比（月视图 12 个月补满，收入正显示）
    const ie = await win.evaluate(() => window.beanwise.getIncomeExpenseReport({ granularity: 'month', year: 2026 }))
    expect(ie.series).toHaveLength(12)
    expect(ie.series.find((p) => p.period === '2026-01')).toEqual({ period: '2026-01', income: '0', expense: '20' })
    expect(ie.series.find((p) => p.period === '2026-02')).toEqual({ period: '2026-02', income: '10000', expense: '0' })

    // 4. UI：报表视图渲染（菜单 → 面板可见 + 余额表精确文本 + 图表容器存在 + 无错误条）
    await win.getByRole('menuitem', { name: '报表' }).click()
    await expect(win.getByText('净资产趋势')).toBeVisible()
    await expect(win.getByText('收支对比')).toBeVisible()
    await expect(win.getByText('账户余额')).toBeVisible()
    // 余额表精确金额文本（滚动到可见后断言）
    await expect(win.locator('.ant-table-tbody')).toContainText('19960 CNY')
    await expect(win.locator('.ant-table-tbody')).toContainText('-20 CNY')
    // 图表容器存在（G2 渲染 canvas）
    await expect(win.locator('canvas').first()).toBeVisible()
    // 无错误条
    await expect(win.locator('.ant-alert-error')).toHaveCount(0)

    // 5. 粒度切换：年视图不报错（图表容器仍在）
    await win.getByRole('radio', { name: '年' }).click()
    await expect(win.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.ant-alert-error')).toHaveCount(0)

    await app.close()
  } finally {
    rmSync(dirname(ledgerPath), { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: 本机 E2E 验证**

```bash
env -u ELECTRON_RUN_AS_NODE npm run build && env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/reports.spec.ts
```

Expected: PASS。若 `Segmented` 的年选项可访问名不是「年」导致 `getByRole('radio', { name: '年' })` 失败，改为 `win.getByText('年').click()`（Segmented 选项文本定位，实测为准）。

- [ ] **Step 4: 提交**

```bash
git add python/tests/fixtures/reports.beancount e2e/reports.spec.ts
git commit -m "test: E2E 报表渲染真实数据（IPC 精确聚合 + 余额表 + 图表容器）（M8-T8）"
```

---

## Task 9（M8-T9）：发布加固（无签名口径）+ ADR 14/15 + antd v6 评估

**Files:**
- Modify: `.github/workflows/release.yml`（无签名口径：移除 CSC_* env 与签名注释）
- Modify: `technical-proposal/release-pipeline.md`（「签名要求」节改为无签名风险说明）
- Modify: `technical-proposal/design-decisions.md`（追加 ADR 14 / ADR 15 / antd v6 评估 ADR）

**Interfaces:**
- 验收：`release.yml` 无任何 `CSC_` 引用；`latest.yml` 随产物断言保留（易错点 #1）；ADR 表格新增 3 行

- [ ] **Step 1: release.yml 无签名口径调整**

`.github/workflows/release.yml` 的「Build installer」步骤改为：

```yaml
      # 签名策略（M8 裁决：放弃签名——无 CSC_* secrets；electron-builder 无证书自动跳过签名，
      # CSC_IDENTITY_AUTO_DISCOVERY=false 防止误扫本机证书库。SmartScreen 风险见 release-pipeline.md）
      - name: Build installer
        run: npm run dist:win -- --publish never
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
```

删除原有 `CSC_LINK: ${{ secrets.CSC_LINK }}` 与 `CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}` 两行及旧注释。

验证：`grep -n "CSC" .github/workflows/release.yml` 仅剩 `CSC_IDENTITY_AUTO_DISCOVERY` 一行；tag 触发链路（release job）不动。

- [ ] **Step 2: release-pipeline.md 更新「签名要求」**

`technical-proposal/release-pipeline.md` 中「签名要求（自动更新硬性前置）」节整体替换为：

```markdown
## 签名现状（M8 裁决：放弃签名）

| 状态 | 说明 |
|---|---|
| 策略 | **不签名**：无 Authenticode 证书，不配 CSC_* secrets；electron-builder 无证书自动跳过签名（`CSC_IDENTITY_AUTO_DISCOVERY=false` 防误扫本机证书库） |
| 自动更新 | electron-updater 不校验 Authenticode，未签名包升级链路可通（latest.yml 随产物发布即可） |
| 风险 | 未签名安装包被 SmartScreen 拦截，用户需「更多信息 → 仍要运行」放行；自动更新安装同样触发 |
| 后续 | 证书到位后补一次签名发布演练（CSC_LINK/CSC_KEY_PASSWORD secrets + release.yml 恢复 env），无需改动其他链路 |
```

同文件「易错点」第 2 条更新为：`latest.yml` 必须随产物发布（缺了自动更新静默失败）；未签名产物 SmartScreen 拦截属预期（M8 裁决接受）。

- [ ] **Step 3: ADR 14/15 落地**

`technical-proposal/design-decisions.md` ADR 表格末尾追加两行：

```markdown
| 14 | 报表数据源 | 未定义 | **SQLite 索引聚合（不经 Python）** | M3 索引设计目标即「按日期/账户建索引，支撑图表聚合查询」；毫秒级、不重复解析账本文件；金额累计全走 decimal.ts 精确字符串运算（SQLite SUM() 对 TEXT 转 REAL 丢精度，违反「金额十进制字符串」铁律）——SQL 只做行筛选/排序。**M8 落地（2026-08-11）**：report 域三通道（net-worth / balances / income-expense）+ report-aggregation 纯函数层；趋势图仅运营货币，余额树多币种分行 |
| 15 | 升级链 | 未定义 | **electron-updater + 主进程状态机 + 无签名发布** | release-pipeline 既定链路；updater 状态机（idle/checking/available/downloading/downloaded/error）事件单向映射，`update:status-changed` 事件推送渲染端；`BEANWISE_UPDATE_FEED_URL` 注入 mock 更新源（E2E 零发布成本）；放弃签名（electron-updater 不校验 Authenticode，SmartScreen 风险接受，证书到位后补签）。**M8 落地（2026-08-11）** |
```

- [ ] **Step 4: antd v6 评估（只评估不迁移）→ 追加评估 ADR**

```bash
npm view antd version
npm view @ant-design/pro-components version peerDependencies
npm view @ant-design/charts version peerDependencies
```

按实测输出与 CLAUDE.md「antd 锁定 5.x」约束，在 design-decisions.md 追加：

```markdown
| 16 | antd v6 迁移评估 | 未定 | **保持 antd 5.x，M9 再评估** | M8 图表期评估（<实测结论>）：antd 最新 <v6 版本号>，pro-components <版本号>（peer <依赖范围>）——<是否满足迁移条件 / 风险点>；图表库 <@ant-design/charts 版本> peer 兼容。结论：<保持 5.x / 启动迁移>，理由 <一句话> |
```

若 `npm view` 输出表明 v6 已发布且 pro-components 3.x peer 支持 v6、图表库兼容 React 19，则结论写「启动迁移（单独里程碑）」，否则「保持 5.x，M9 再评估」。以实测为准，不留 TBD。

- [ ] **Step 5: 验证 + 提交**

```bash
grep -n "CSC" .github/workflows/release.yml
npm run typecheck && npm run test:unit
```

```bash
git add .github/workflows/release.yml technical-proposal/release-pipeline.md technical-proposal/design-decisions.md
git commit -m "docs: 发布加固无签名口径 + ADR 14/15/16（报表数据源/升级链/antd v6 评估）（M8-T9）"
```

---

## Task 10（M8-T10）：文档定稿同步（CLAUDE.md + roadmap）

**Files:**
- Modify: `CLAUDE.md`（技术栈：Ant Charts + electron-updater 条目；常见坑：报表聚合口径一句话）
- Modify: `technical-proposal/implementation-roadmap.md`（M8 行绿灯标注 + IPC 契约表追加 report/update 通道）

**Interfaces:**
- 验收：CLAUDE.md 技术栈含 Ant Charts 与 electron-updater；roadmap IPC 契约表含 report 域三通道 + update 域三通道 + 事件通道；M8 行追加「计划生成（2026-08-11）」标注

- [ ] **Step 1: CLAUDE.md 技术栈更新**

`CLAUDE.md` 技术栈段落，AI 辅助条目后追加：

```markdown
- **报表**：@ant-design/charts（Ant Charts 2.6.x，peer `react >=16.8.4` 兼容 React 19）+ electron-updater（主进程状态机封装，`update:status-changed` 事件推送）——M8 定稿；报表数据源 = SQLite 索引聚合（不经 Python），金额累计走 decimal.ts 精确字符串运算（SQLite SUM 转 REAL 丢精度禁用）
```

「常见坑」追加一条：

```markdown
- 报表聚合禁 SQL `SUM()`（TEXT→REAL 丢精度）：SQL 只做行筛选排序，金额累计一律 `addDecimalStrings`；图表 y 值 `Number()` 仅显示层
- electron-updater E2E 注入：`BEANWISE_UPDATE_FEED_URL` → `setFeedURL` + `forceDevUpdateConfig`（dev 无 app-update.yml）；latest.yml 须同时声明 `.exe` 与 `.AppImage` 条目（CI ubuntu 走 AppImageUpdater）
```

- [ ] **Step 2: roadmap 更新**

`technical-proposal/implementation-roadmap.md`：

1. 里程碑总览 M8 行追加标注：`✅ 计划（2026-08-11）`
2. 「IPC 契约」表格追加：

```markdown
  | `report:net-worth`（M8） | `{granularity: 'month'\|'year'}` | `{series: [{period, assets, liabilities, netWorth}], currency, message?}`（期间累计，仅运营货币；金额 decimal 字符串） |
  | `report:balances`（M8） | 无 | `{accounts: [{name, balances: [{currency, number}], children?}], message?}`（账户树 + 子树 rollup，多币种分行） |
  | `report:income-expense`（M8） | `{granularity, year?}` | `{series: [{period, income, expense}], currency, message?}`（income/expense 正显示；月视图 12 个月补满，year 缺省最近年份） |
  | `update:check`（M8） | 无 | `{ok, message?}`（触发 updater 状态机） |
  | `update:status`（M8） | 无 | `UpdateState`（idle/checking/available/downloading/downloaded/error + currentVersion/progress/error） |
  | `update:install`（M8） | 无 | `{ok, message?}`（quitAndInstall）；事件 `update:status-changed` main→renderer |
```

- [ ] **Step 3: 验证 + 提交**

```bash
npm run typecheck
```

```bash
git add CLAUDE.md technical-proposal/implementation-roadmap.md
git commit -m "docs: M8 定稿同步——CLAUDE.md 报表/更新栈 + roadmap report/update 通道记录（M8-T10）"
```

---

## M8 绿灯验收清单（对照 spec 第 1 节）

| 绿灯 | 落点 |
|---|---|
| 图表渲染真实数据 | T8 E2E（IPC 精确聚合断言 + 余额表文本 + 图表容器）+ 手工打开报表视图目视 |
| 升级演练 | T7 E2E（mock 源：检查→下载→downloaded）；首版人工演练：tag v0.1.0 → Release → 装旧版 → v0.1.1 → 应用内更新（未签名，SmartScreen 预期警告） |
| 完整发布演练（tag → Release → 更新） | T9 release.yml 核对 + 首版人工演练（发布后执行，T7/T9 铺好全部前置） |
