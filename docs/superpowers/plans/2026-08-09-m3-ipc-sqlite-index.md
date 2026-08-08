# M3 IPC 骨架 + SQLite 索引 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 3 层 IPC 骨架（shared 契约 → preload 白名单 → main handler）+ SQLite 索引（Drizzle 三表 + 增量解析→索引重建）+ PythonSvc 生命周期（spawn / 指数退避重启 / 优雅关闭），绿灯验收：手工写入一笔交易 → 索引可见，typecheck 绿。

**Architecture:** 主进程持有三件套：`PythonSvc`（stdio JSON-RPC 客户端，M2 引擎的无状态协议不变）、`db`（better-sqlite3 + Drizzle，三表：`ledger_meta` / `entries` / `postings`）、`index-builder`（索引重建管线：SHA-256 变更检测 → `parse_entries` 校验 → 事务重建）。IPC 通道 `ledger:refresh-index` / `ledger:status` / `ledger:list-entries` 按 roadmap 契约从 `src/shared/ipc.ts` 定义 → preload 白名单 → main handler 注册（handler 可注入 mock 以脱离 Electron 单测）。「增量解析」在本里程碑的语义 = 文件 hash 变更检测（未变则跳过）+ 校验通过后全量重建（唯一事实源原则：**先校验 → 通过才重建，失败保持旧索引**）。验收载体：极简只读索引面板（纯 React，不引入 antd——那是 M4 的业务 UI 依赖）。

**Tech Stack:** Electron · better-sqlite3 · drizzle-orm（sqlite-core，不引入 drizzle-kit）· Node crypto（SHA-256）· Vitest · Playwright（E2E）· Python 引擎（新增 `parse_entries` 方法）

## Global Constraints

- **版本与平台**：Windows-only（本机开发）；Electron 43 · Node 22（CI）· Python 3.11（本机经 py launcher：`py -3.11`，`python` 命令是 3.8 不可用；可用 `BEANWISE_PYTHON_CMD` 环境变量覆盖，如 `py -3.11` / `python3`）
- **原生模块（CLAUDE.md 约束 #7）**：better-sqlite3 必须 `electron-builder install-app-deps`（package.json `postinstall`）+ electron-builder.yml `asarUnpack`；本地安装失败时先查 node-gyp 日志，需要 VS Build Tools（windows-latest runner 自带，本机若无需 `npm install -g windows-build-tools` 或换 Electron 预编译 ABI）
- **新增 RPC 契约（M2 协议扩展，Task 1 定稿并同步 roadmap）**：`parse_entries: {filename} → {entries: [...], errors: [...], options: {...}}`；entries 元素为扁平结构（类型专属字段，其余省略）：
  - 通用：`{type, date: "YYYY-MM-DD", lineno}`
  - Transaction 追加：`{flag, payee, narration, postings: [{account, units_number: str, units_currency, cost_number: str|null, cost_currency: str|null}]}`
  - Open 追加：`{account}`
  - **Decimal 一律 str() 序列化**（与 M2 协议一致，M2 已定稿「Decimal 转字符串」）；`str(Decimal('-15.00')) == '-15.00'`（保留精度）
- **数据库契约（M3 定稿，M4-M8 直接引用）**：
  - DB 文件：`join(app.getPath('userData'), 'beanwise.db')`（测试用 `:memory:` 或临时文件）；`journal_mode = WAL` + `foreign_keys = ON`
  - 表：`ledger_meta`（单行 id=1：ledger_path / title / operating_currency(JSON 数组字符串) / mtime_ms / file_hash / entry_count / error_count / status('ok'|'error'|'missing') / last_error / updated_at(ms)）；`entries`（id 自增 / type / date(TEXT ISO，便于排序) / flag / payee / narration / account(Open 用) / lineno）；`postings`（id 自增 / entry_id FK→entries ON DELETE CASCADE / account / units_number(TEXT) / units_currency / cost_number / cost_currency）
  - 索引：`idx_entries_date(entries.date)`、`idx_postings_account(postings.account)`、`idx_postings_entry(postings.entry_id)`
  - 金额一律 TEXT 存（Decimal 精度，渲染端再转）
- **IPC 契约（roadmap「IPC 契约」节，M3 定稿并同步 roadmap）**：
  - 通道命名小写 kebab：`ledger:refresh-index`（无参）/ `ledger:status`（无参）/ `ledger:list-entries`（params: `{limit?, offset?}`）
  - 类型唯一来源 `src/shared/ipc.ts`：`LedgerStatus`（path/title/operatingCurrency[]/entryCount/errorCount/status/lastError/updatedAt，status 为 'ok'|'error'|'missing'）、`LedgerEntryRow`（id/type/date/flag/payee/narration/account/lineno）、`ListEntriesParams`（limit 默认 100 上限 1000；offset 默认 0 且 ≥0）、`ListEntriesResult`（entries/total）、`RefreshResult`（changed/status/entryCount/errorCount/message?）
  - 主进程 handler 对入参做类型与范围校验（非法 → throw，渲染进程 invoke reject）；路径不来自渲染进程（账本路径主进程持有，防目录穿越）
- **账本路径解析**：`BEANWISE_LEDGER_PATH` 环境变量优先（E2E/测试注入 fixture），否则 `join(app.getPath('documents'), 'beanwise', 'main.beancount')`；文件不存在 → 索引 status='missing'（本里程碑不做骨架文件创建，留 M4 录入链路）
- **PythonSvc 生命周期**：惰性 spawn（首次 request 才启动）；开发模式命令 `py -3.11 python/service.py --stdio`（`BEANWISE_PYTHON_CMD` 可覆盖），打包后 `join(process.resourcesPath, 'python/beancount-engine.exe') --stdio`；请求默认超时 30s（shutdown 覆盖为 5s）；异常退出按指数退避重启（1s 起、上限 30s，可注入）；`before-quit` 优雅关闭（shutdown RPC → 等退出 → 5s 后 kill 兜底）
- **数据流铁律（roadmap「数据流铁律」）**：先落文件 → 校验 → 通过才重建 SQLite 索引；`parse_entries` 返回 errors 非空 → status='error' 且**不重建**（旧索引保持）；RPC 失败 → 记日志 + status='error'；hash 未变 → 跳过（changed=false）
- **渲染进程边界**：不直连 Python / SQLite，一律走 IPC 白名单；preload 只暴露 `appName` + 三个通道方法
- **测试**：Vitest 跑 `src/**/*.test.ts`（node 环境，Electron 模块不可 import，handler 用注入式 mock）；fixture 复用 `python/tests/fixtures/main.beancount`（合法账本：3 open + 2 交易 = 5 entries）与 `bad.beancount`（3 entries + 1 error）；E2E 通过 `BEANWISE_LEDGER_PATH` 指向 fixture；PythonSvc 单测中真实 spawn 引擎（CI test job 已 pip 前置），重启退避测试注入假命令
- **不做（M3 边界，roadmap「里程碑边界说明」）**：业务 UI / 录入表单（M4，引入 antd）；fs.watch 自动监听文件变更（M4/M5 保存链路主动触发 refresh）；账本骨架文件自动创建（M4）；`query`/`renderReport` 的 Node 侧封装（M8）；git 同步（M6）
- **提交**：每个任务一个 commit，约定式前缀，中文消息（与 M1/M2 一致）；不附加任何 Co-Authored-By 署名
- **文档同步（Task 8）**：`technical-proposal/implementation-roadmap.md` 同步——「Node ↔ Python」方法表加 `parse_entries`、「IPC 契约」节补 M3 定稿通道表

---

### Task 1: Python 引擎扩展 parse_entries（结构化条目数据源）

**Files:**
- Modify: `python/engine/ledger.py`（+ `_serialize_entry` + `parse_entries`）
- Modify: `python/engine/rpc.py`（注册 `parse_entries`）
- Modify: `python/tests/test_ledger.py`（+ 3 个测试）

**Interfaces:**
- Consumes: Task 1 之前 M2 已定的 `loader.load_file` 管线、`_serialize_errors` / `_serialize_options`（`engine/ledger.py`）、`RpcError` / `_require_string`（`engine/rpc.py`）
- Produces: `ledger.parse_entries(filename: str) -> dict`（`{entries, errors, options}`）——Task 4 index-builder 的索引数据源；RPC 方法 `parse_entries`——Task 3 PythonSvc 封装 `parseEntries()` 的底层方法；M3 定稿契约（Global Constraints「新增 RPC 契约」）

- [ ] **Step 1: 写测试（红）**

`python/tests/test_ledger.py` 追加：

```python
def test_parse_entries_transaction_structure():
    result = parse_entries(MAIN)
    assert result["errors"] == []
    transactions = [e for e in result["entries"] if e["type"] == "Transaction"]
    assert len(transactions) == 2
    first = transactions[0]
    assert first["date"] == "2026-01-02"
    assert first["flag"] == "*"
    assert first["payee"] == "Breakfast"
    assert first["narration"] is None  # fixture 单字符串是 payee，narration 空
    assert isinstance(first["lineno"], int)
    assert first["postings"] == [
        {"account": "Assets:Bank:CNB", "units_number": "-15.00",
         "units_currency": "CNY", "cost_number": None, "cost_currency": None},
        {"account": "Expenses:Food", "units_number": "15.00",
         "units_currency": "CNY", "cost_number": None, "cost_currency": None},
    ]


def test_parse_entries_open_entry_has_account():
    result = parse_entries(MAIN)
    open_entries = [e for e in result["entries"] if e["type"] == "Open"]
    assert len(open_entries) == 3
    assert open_entries[0]["account"] == "Assets:Bank:CNB"
    assert "postings" not in open_entries[0]


def test_parse_entries_bad_ledger_keeps_errors():
    result = parse_entries(BAD)
    assert len(result["errors"]) == 1
    assert result["errors"][0]["type"] == "ValidationError"
```

- [ ] **Step 2: 运行确认失败（红）**

Run: `py -3.11 -m pytest python/tests/test_ledger.py`
Expected: FAIL——`AttributeError: module 'engine.ledger' has no attribute 'parse_entries'`

- [ ] **Step 3: 写实现**

`python/engine/ledger.py` 顶部导入改为（现为 `from beancount import loader`）：

```python
from beancount import loader
from beancount.core.data import Open, Transaction
```

文件末尾追加：

```python
def _serialize_entry(entry) -> dict:
    """把 beancount entry 转成 JSON 友好 dict（M3 SQLite 索引数据源）。

    扁平结构：通用字段（type/date/lineno）+ 类型专属字段（Transaction 的
    postings、Open 的 account），其余类型只带通用字段。金额 Decimal 一律
    str() 保持精度（与 M2 协议一致）。
    """
    item = {
        "type": type(entry).__name__,
        "date": entry.date.isoformat(),
        "lineno": entry.meta.get("lineno") if isinstance(entry.meta, dict) else None,
    }
    if isinstance(entry, Transaction):
        item["flag"] = entry.flag
        item["payee"] = entry.payee
        item["narration"] = entry.narration
        item["postings"] = [
            {
                "account": p.account,
                "units_number": str(p.units.number),
                "units_currency": p.units.currency,
                "cost_number": str(p.cost.number) if p.cost else None,
                "cost_currency": p.cost.currency if p.cost else None,
            }
            for p in entry.postings
        ]
    elif isinstance(entry, Open):
        item["account"] = entry.account
    return item


def parse_entries(filename: str) -> dict:
    """解析文件，返回条目明细 + 错误列表 + options（M3 SQLite 索引数据源）。"""
    entries, errors, options = loader.load_file(filename)
    return {
        "entries": [_serialize_entry(e) for e in entries],
        "errors": _serialize_errors(errors),
        "options": _serialize_options(options),
    }
```

- [ ] **Step 4: rpc.py 注册方法**

`python/engine/rpc.py` 的 `_parse_file` 之后加：

```python
def _parse_entries(params: dict) -> dict:
    filename = _require_string(params, "filename")
    return ledger.parse_entries(filename)
```

`METHODS` 表在 `"parse_file": _parse_file,` 后加一行：

```python
    "parse_entries": _parse_entries,
```

- [ ] **Step 5: 运行确认通过（绿）**

Run: `py -3.11 -m pytest python/tests`
Expected: PASS（19 + 3 = 22 个用例）

- [ ] **Step 6: Commit**

```bash
git add python/
git commit -m "feat: 引擎 parse_entries 方法（结构化条目序列化，M3 索引数据源）（M3）
"
```

---

### Task 2: 依赖 + DB 层（better-sqlite3 + Drizzle schema + 建表）

**Files:**
- Modify: `package.json`（dependencies + postinstall script）
- Modify: `electron-builder.yml`（asarUnpack）
- Create: `src/main/db/schema.ts`
- Create: `src/main/db/index.ts`
- Create: `src/main/db/index.test.ts`

**Interfaces:**
- Consumes: 无（本任务独立，不依赖 Task 1）
- Produces: `openDatabase(filename: string): Database.Database`（建库建表、WAL、foreign_keys）、`createDrizzle(db: Database.Database): DrizzleDb`（drizzle 包装）、`ledgerMeta / entries / postings` 三表定义（`db/schema.ts`）——Task 4 index-builder 与 Task 5/6 全部数据访问的基础

- [ ] **Step 1: 安装依赖**

Run:
```bash
npm install better-sqlite3 drizzle-orm
```
Expected: 安装成功。Windows 本机若有编译错误（node-gyp），按 Global Constraints「原生模块」排障。

- [ ] **Step 2: package.json 加 postinstall + electron-builder.yml 加 asarUnpack**

`package.json` 的 scripts 加（放在 `build:python` 之后）：

```json
    "postinstall": "electron-builder install-app-deps",
```

`electron-builder.yml` 的 `files:` 之后加（原生模块必须解包，CLAUDE.md 约束 #7）：

```yaml
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
```

- [ ] **Step 3: 验证原生模块可被 Electron 加载**

Run:
```bash
npx electron-rebuild --version >/dev/null 2>&1 && echo "electron-rebuild 可用" || npm install --save-dev electron-rebuild
npm run postinstall
```
Expected: `install-app-deps` 输出 better-sqlite3 rebuild 成功（首次需下载 Electron ABI 预编译或本地编译，国内网络慢可设置 `ELECTRON_MIRROR` 后重试）。

- [ ] **Step 4: 写 schema（红）**

`src/main/db/schema.ts`：

```ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** SQLite 索引表结构（M3 定稿，M4-M8 直接引用）。金额一律 TEXT（Decimal 精度）。 */

export const ledgerMeta = sqliteTable('ledger_meta', {
  id: integer('id').primaryKey(), // 恒为 1（单行）
  ledgerPath: text('ledger_path').notNull(),
  title: text('title'),
  operatingCurrency: text('operating_currency'), // JSON 数组字符串，如 '["CNY"]'
  mtimeMs: integer('mtime_ms'),
  fileHash: text('file_hash'),
  entryCount: integer('entry_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  status: text('status', { enum: ['ok', 'error', 'missing'] }).notNull().default('missing'),
  lastError: text('last_error'),
  updatedAt: integer('updated_at') // epoch ms
})

export const entries = sqliteTable('entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  date: text('date').notNull(), // ISO YYYY-MM-DD，字符串排序即时间序
  flag: text('flag'),
  payee: text('payee'),
  narration: text('narration'),
  account: text('account'), // 仅 Open 条目
  lineno: integer('lineno')
})

export const postings = sqliteTable('postings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entryId: integer('entry_id')
    .notNull()
    .references(() => entries.id, { onDelete: 'cascade' }),
  account: text('account').notNull(),
  unitsNumber: text('units_number').notNull(),
  unitsCurrency: text('units_currency').notNull(),
  costNumber: text('cost_number'),
  costCurrency: text('cost_currency')
})
```

- [ ] **Step 5: 写 DB 打开/建表（实现）**

`src/main/db/index.ts`：

```ts
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type DrizzleDb = ReturnType<typeof createDrizzle>

/** 建表 DDL。与 schema.ts 表定义一一对应（drizzle 不生成 DDL，索引可随时重建，无需 migration）。 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS ledger_meta (
  id INTEGER PRIMARY KEY,
  ledger_path TEXT NOT NULL,
  title TEXT,
  operating_currency TEXT,
  mtime_ms INTEGER,
  file_hash TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'missing',
  last_error TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  flag TEXT,
  payee TEXT,
  narration TEXT,
  account TEXT,
  lineno INTEGER
);
CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  units_number TEXT NOT NULL,
  units_currency TEXT NOT NULL,
  cost_number TEXT,
  cost_currency TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account);
CREATE INDEX IF NOT EXISTS idx_postings_entry ON postings(entry_id);
`

export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_DDL)
  return db
}

export function createDrizzle(db: Database.Database): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(db, { schema })
}
```

（`DrizzleDb` 类型别名与 `createDrizzle` 的返回类型写法二选一即可，保持唯一；若 typecheck 报递归问题，删掉 `DrizzleDb` 别名、调用处以 `ReturnType<typeof createDrizzle>` 标注。）

- [ ] **Step 6: 写测试（绿）**

`src/main/db/index.test.ts`：

```ts
import { desc } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDrizzle, openDatabase } from './index'
import { entries, ledgerMeta, postings } from './schema'

describe('SQLite 索引层（M3）', () => {
  let db: ReturnType<typeof openDatabase>

  beforeAll(() => {
    db = openDatabase(':memory:')
  })
  afterAll(() => {
    db.close()
  })

  it('建表后三张表可用，单行 meta 写入读取往返', () => {
    const drizzle = createDrizzle(db)
    drizzle.insert(ledgerMeta).values({
      id: 1,
      ledgerPath: '/tmp/main.beancount',
      status: 'ok',
      entryCount: 5,
      updatedAt: 123
    }).run()
    const row = drizzle.select().from(ledgerMeta).get()
    expect(row?.ledgerPath).toBe('/tmp/main.beancount')
    expect(row?.status).toBe('ok')
  })

  it('entries + postings 写入与级联删除', () => {
    const drizzle = createDrizzle(db)
    const entry = drizzle
      .insert(entries)
      .values({ type: 'Transaction', date: '2026-01-02', payee: 'Breakfast', lineno: 8 })
      .returning()
      .get()
    drizzle.insert(postings).values({
      entryId: entry.id,
      account: 'Assets:Bank:CNB',
      unitsNumber: '-15.00',
      unitsCurrency: 'CNY'
    }).run()

    const rows = drizzle
      .select()
      .from(postings)
      .where((t) => t.entryId.eq(entry.id))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0].unitsNumber).toBe('-15.00')

    drizzle.delete(entries).where((t) => t.id.eq(entry.id)).run()
    expect(
      drizzle.select().from(postings).where((t) => t.entryId.eq(entry.id)).all()
    ).toHaveLength(0) // FK cascade 生效
  })

  it('date 索引按时间序查询', () => {
    const drizzle = createDrizzle(db)
    drizzle.insert(entries).values([
      { type: 'Open', date: '2026-01-01', account: 'Assets:Bank:CNB' },
      { type: 'Open', date: '2026-01-03', account: 'Expenses:Food' }
    ]).run()
    const ordered = drizzle.select().from(entries).orderBy(desc(entries.date)).all()
    expect(ordered[0].date).toBe('2026-01-03')
  })
})
```

- [ ] **Step 7: 运行确认通过（绿）**

Run: `npm run test:unit`
Expected: PASS（原 4 个用例 + 本文件 3 个用例 = 7 passed）

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json electron-builder.yml src/main/db/
git commit -m "feat: SQLite 索引层（Drizzle 三表 + better-sqlite3 原生模块配置）（M3）
"
```

---

### Task 3: PythonSvc（stdio JSON-RPC 客户端 + 生命周期）

**Files:**
- Create: `src/main/python-svc.ts`
- Create: `src/main/python-svc.test.ts`

**Interfaces:**
- Consumes: 本机/CI Python 引擎入口（`py -3.11 python/service.py --stdio`，`BEANWISE_PYTHON_CMD` 可覆盖）；Task 1 的 `parse_entries` RPC 方法
- Produces: `class PythonSvc`——构造 `new PythonSvc({command: string[], requestTimeoutMs?, shutdownTimeoutMs?, initialRetryDelayMs?, maxRetryDelayMs?})`；方法 `start(): Promise<void>`（惰性 spawn）、`request<T>(method: string, params?: object, timeoutMs?: number): Promise<T>`、`ping() / validate(filename) / parseFile(filename) / parseEntries(filename)`、`stop(): Promise<void>`、`restartCount: number`（只读）——Task 4 index-builder、Task 6 主进程接线与 Task 7 E2E 的引擎访问入口；测试可注入假命令验证退避重启

- [ ] **Step 1: 写测试（红）**

`src/main/python-svc.test.ts`：

```ts
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PythonSvc } from './python-svc'

// 本机 Windows 用 py launcher（`python` 命令是 3.8 不可用），CI ubuntu 用 python3；
// 可用环境变量 BEANWISE_PYTHON_CMD 覆盖，如 'py -3.11' / 'python3'
const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

describe('PythonSvc 生命周期与 RPC（M3）', () => {
  const svcs: PythonSvc[] = []
  const track = (svc: PythonSvc) => {
    svcs.push(svc)
    return svc
  }
  afterEach(async () => {
    await Promise.all(svcs.splice(0).map((s) => s.stop()))
  })

  it('ping 往返 + parseEntries 返回结构化条目（真实引擎）', async () => {
    const svc = track(new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] }))
    await expect(svc.ping()).resolves.toEqual({ pong: true })

    const result = await svc.parseEntries(FIXTURE)
    expect(result.errors).toEqual([])
    const txs = result.entries.filter((e) => e.type === 'Transaction')
    expect(txs).toHaveLength(2)
    expect(txs[0].postings?.[0]).toEqual({
      account: 'Assets:Bank:CNB',
      units_number: '-15.00',
      units_currency: 'CNY',
      cost_number: null,
      cost_currency: null
    })
  }, 30_000)

  it('请求超时返回拒绝', async () => {
    // 不启动真实引擎：spawn 一个不响应 stdin 的进程，request 必超时
    const svc = track(new PythonSvc({ command: ['node', '-e', 'setInterval(() => {}, 1000)'], requestTimeoutMs: 300 }))
    await expect(svc.request('ping')).rejects.toThrow(/超时/)
  }, 10_000)

  it('异常退出后指数退避重启（假命令注入）', async () => {
    const svc = track(
      new PythonSvc({
        command: ['node', '-e', 'process.exit(1)'],
        initialRetryDelayMs: 50,
        maxRetryDelayMs: 100
      })
    )
    await svc.start()
    const deadline = Date.now() + 5_000
    while (svc.restartCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(svc.restartCount).toBeGreaterThanOrEqual(2)
  }, 10_000)

  it('stop 优雅关闭：shutdown 后进程退出 0（真实引擎）', async () => {
    const svc = track(new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] }))
    await svc.ping()
    await svc.stop()
    expect(svc.isRunning()).toBe(false)
  }, 30_000)
})
```

- [ ] **Step 2: 运行确认失败（红）**

Run: `npm run test:unit -- src/main/python-svc.test.ts`
Expected: FAIL——`Cannot find module './python-svc'`

- [ ] **Step 3: 写实现**

`src/main/python-svc.ts`：

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface PythonSvcOptions {
  /** 引擎启动命令（含参数），如 ['py', '-3.11', 'python/service.py', '--stdio'] */
  command: string[]
  /** 单个 RPC 请求超时，默认 30_000 */
  requestTimeoutMs?: number
  /** shutdown 请求超时，默认 5_000 */
  shutdownTimeoutMs?: number
  /** 异常退出后首次重试延迟，默认 1_000 */
  initialRetryDelayMs?: number
  /** 重试延迟上限（指数退避），默认 30_000 */
  maxRetryDelayMs?: number
}

export class PythonSvcError extends Error {}

interface RpcEnvelope {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

interface ParseEntriesResult {
  entries: Array<Record<string, unknown> & { postings?: unknown[] }>
  errors: Array<{ type: string; message: string; filename?: string | null; lineno?: number | null }>
  options: Record<string, unknown>
}

/** Python 引擎 stdio JSON-RPC 客户端：惰性 spawn、带超时请求、异常退出指数退避重启、优雅关闭。 */
export class PythonSvc {
  private proc: ChildProcess | null = null
  private pending = new Map<number, (env: RpcEnvelope) => void>()
  private nextId = 1
  private retryDelay: number
  private retryTimer: NodeJS.Timeout | null = null
  private stopping = false
  private restartCountValue = 0

  constructor(private readonly options: PythonSvcOptions) {
    this.retryDelay = options.initialRetryDelayMs ?? 1_000
  }

  /** 已重启次数（异常退出触发，测试与日志用） */
  get restartCount(): number {
    return this.restartCountValue
  }

  /** 进程当前是否存活 */
  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  private ensureRunning(): void {
    if (this.proc !== null && this.proc.exitCode === null) return
    this.spawnProcess()
  }

  private spawnProcess(): void {
    const [cmd, ...args] = this.options.command
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    this.proc = proc
    proc.stdin?.on('error', () => {}) // 进程提前退出时忽略管道错误
    proc.stdout?.on('error', () => {})
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      let env: RpcEnvelope
      try {
        env = JSON.parse(line) as RpcEnvelope
      } catch {
        return // 非法行丢弃（引擎不应输出非 JSON）
      }
      const resolve = this.pending.get(env.id)
      if (resolve) {
        this.pending.delete(env.id)
        resolve(env)
      }
    })
    proc.on('exit', (code, signal) => {
      this.proc = null
      // 进程死了，所有在途请求直接失败
      const err = new PythonSvcError(`引擎进程退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      for (const resolve of this.pending.values()) resolve({ id: 0, error: { code: -32603, message: err.message } })
      this.pending.clear()
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopping || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.restartCountValue += 1
      this.spawnProcess()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, this.options.maxRetryDelayMs ?? 30_000)
  }

  /** 确保进程在跑（惰性：首次调用才 spawn） */
  async start(): Promise<void> {
    this.ensureRunning()
    // 等 3 次 ping 机会（最多 3s），让进程就绪
    for (let i = 0; i < 3; i++) {
      try {
        await this.request('ping', {}, 1_000)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    this.ensureRunning()
    const proc = this.proc
    if (!proc || proc.exitCode !== null) {
      return Promise.reject(new PythonSvcError('引擎进程不可用'))
    }
    const id = this.nextId++
    const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new PythonSvcError(`RPC 请求超时（${timeout}ms）：${method}`))
      }, timeout)
      this.pending.set(id, (env) => {
        clearTimeout(timer)
        if (env.error) {
          reject(new PythonSvcError(`RPC 错误 ${env.error.code}: ${env.error.message}`))
        } else {
          resolvePromise(env.result as T)
        }
      })
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  ping(): Promise<{ pong: boolean }> {
    return this.request('ping')
  }

  validate(filename: string): Promise<{ errors: ParseEntriesResult['errors'] }> {
    return this.request('validate', { filename })
  }

  parseFile(filename: string): Promise<{ entry_count: number; errors: ParseEntriesResult['errors']; options: ParseEntriesResult['options'] }> {
    return this.request('parse_file', { filename })
  }

  parseEntries(filename: string): Promise<ParseEntriesResult> {
    return this.request('parse_entries', { filename })
  }

  /** 优雅关闭：shutdown RPC → 等待退出 → 超时 kill 兜底 */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return
    try {
      await this.request('shutdown', {}, this.options.shutdownTimeoutMs ?? 5_000)
    } catch {
      // 进程已退出或 shutdown 失败，交给下方等待/兜底
    }
    await Promise.race([
      new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit())),
      new Promise<void>((resolveExit) => setTimeout(resolveExit, (this.options.shutdownTimeoutMs ?? 5_000) + 1_000))
    ])
    if (proc.exitCode === null) proc.kill()
  }
}
```

- [ ] **Step 4: 运行确认通过（绿）**

Run: `npm run test:unit -- src/main/python-svc.test.ts`
Expected: PASS（4 个用例；真实引擎用例 Python 首次启动 1~3s 属预期）

- [ ] **Step 5: 回归冒烟确认（M2 基线）**

Run: `npm run test:unit`
Expected: PASS（原 7 个 + 本文件 4 个 = 11 passed；`python-engine-smoke.test.ts` 保持通过——M2 交接要求回归基线不破坏）

- [ ] **Step 6: Commit**

```bash
git add src/main/python-svc.ts src/main/python-svc.test.ts
git commit -m "feat: PythonSvc 生命周期（惰性 spawn / 超时 / 指数退避重启 / 优雅关闭）（M3）
"
```

---

### Task 4: 索引重建管线（index-builder：变更检测 → 校验 → 事务重建）

**Files:**
- Create: `src/main/index-builder.ts`
- Create: `src/main/index-builder.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parse_entries` RPC（经 Task 3 的 `PythonSvc.parseEntries`）；Task 2 的 `openDatabase` / `createDrizzle` / 三表 schema
- Produces: `refreshIndex(db, engine, ledgerPath): Promise<RefreshResult>`（`{changed, status, entryCount, errorCount, message?}`）、`getLedgerStatus(db): LedgerStatus | null`、`listEntries(db, limit, offset): {entries: LedgerEntryRow[], total}`——Task 5 IPC handlers、Task 7 E2E 的调用面；`LedgerStatus` / `LedgerEntryRow` / `ListEntriesParams` / `ListEntriesResult` / `RefreshResult` 类型定义于此文件并在 `src/shared/ipc.ts` 中 re-export（唯一来源）

- [ ] **Step 1: 写测试（红）**

`src/main/index-builder.test.ts`：

```ts
import { copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { getLedgerStatus, listEntries, refreshIndex } from './index-builder'
import { PythonSvc } from './python-svc'

const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const MAIN_FIXTURE = resolve('python/tests/fixtures/main.beancount')
const BAD_FIXTURE = resolve('python/tests/fixtures/bad.beancount')

describe('索引重建管线（M3）', () => {
  let db: ReturnType<typeof openDatabase>
  let engine: PythonSvc
  let workFile: string

  beforeAll(async () => {
    db = openDatabase(':memory:')
    engine = new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] })
    await engine.start()
    workFile = join(tmpdir(), `beanwise-m3-test-${process.pid}.beancount`)
    copyFileSync(MAIN_FIXTURE, workFile)
  })
  afterAll(async () => {
    await engine.stop()
    db.close()
  })

  it('首次刷新：合法账本 → ok + 5 entries + 2 条 Transaction 结构正确', async () => {
    const result = await refreshIndex(db, engine, workFile)
    expect(result.status).toBe('ok')
    expect(result.entryCount).toBe(5)
    expect(result.errorCount).toBe(0)

    const status = getLedgerStatus(db)
    expect(status?.title).toBe('BeanWise Test Ledger')
    expect(status?.operatingCurrency).toEqual(['CNY'])
    expect(status?.status).toBe('ok')

    const listed = listEntries(db, 100, 0)
    expect(listed.total).toBe(5)
    const txs = listed.entries.filter((e) => e.type === 'Transaction')
    expect(txs).toHaveLength(2)
    // fixture 单字符串日期行（2026-01-02 * "Breakfast"）：beancount v3 解析为
    // narration 而非 payee（Task 1 实测确认，payee 为 null）
    expect(txs[0].narration).toBe('Breakfast')
    expect(txs[0].date).toBe('2026-01-02')
  }, 30_000)

  it('内容未变 → changed=false 跳过', async () => {
    const result = await refreshIndex(db, engine, workFile)
    expect(result.changed).toBe(false)
  }, 30_000)

  it('文件追加一笔交易 → changed=true + entryCount=6，新条目可见', async () => {
    writeFileSync(
      workFile,
      '\n2026-01-04 * "Lunch"\n  Assets:Bank:CNB  -30.00 CNY\n  Expenses:Food\n',
      { flag: 'a' }
    )
    const result = await refreshIndex(db, engine, workFile)
    expect(result.changed).toBe(true)
    expect(result.entryCount).toBe(6)
    const listed = listEntries(db, 100, 0)
    expect(listed.entries.some((e) => e.narration === 'Lunch')).toBe(true)
  }, 30_000)

  it('坏账本 → status=error，旧索引保持（不重建）', async () => {
    copyFileSync(BAD_FIXTURE, workFile)
    const result = await refreshIndex(db, engine, workFile)
    expect(result.status).toBe('error')
    expect(result.errorCount).toBe(1)
    expect(result.message).toContain('does not balance')
    // 旧索引仍为上一次 ok 的内容
    expect(getLedgerStatus(db)?.entryCount).toBe(6)
    expect(listEntries(db, 100, 0).total).toBe(6)
  }, 30_000)

  it('文件不存在 → status=missing', async () => {
    const result = await refreshIndex(db, engine, join(tmpdir(), 'no-such-file.beancount'))
    expect(result.status).toBe('missing')
  }, 30_000)

  it('listEntries 分页 limit/offset 生效', async () => {
    copyFileSync(MAIN_FIXTURE, workFile)
    await refreshIndex(db, engine, workFile)
    const page = listEntries(db, 2, 1)
    expect(page.entries).toHaveLength(2)
    expect(page.total).toBe(5)
    expect(page.entries[0].date >= '2026-01-01').toBe(true) // 按 date, id 升序
  }, 30_000)
})
```

- [ ] **Step 2: 运行确认失败（红）**

Run: `npm run test:unit -- src/main/index-builder.test.ts`
Expected: FAIL——`Cannot find module './index-builder'`

- [ ] **Step 3: 写实现**

`src/main/index-builder.ts`：

```ts
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { DrizzleDb } from './db'
import { entries, ledgerMeta, postings } from './db/schema'
import type { PythonSvc } from './python-svc'

export type LedgerIndexStatus = 'ok' | 'error' | 'missing'

export interface RefreshResult {
  /** 内容未变（hash 相同）→ false；未变时 status 反映当前索引状态 */
  changed: boolean
  status: LedgerIndexStatus
  entryCount: number
  errorCount: number
  message?: string
}

export interface LedgerStatus {
  path: string
  title: string | null
  operatingCurrency: string[]
  entryCount: number
  errorCount: number
  status: LedgerIndexStatus
  lastError: string | null
  updatedAt: number | null
}

export interface LedgerEntryRow {
  id: number
  type: string
  date: string
  flag: string | null
  payee: string | null
  narration: string | null
  account: string | null
  lineno: number | null
}

export interface ListEntriesParams {
  limit?: number // 默认 100，上限 1000
  offset?: number // 默认 0，>= 0
}

export interface ListEntriesResult {
  entries: LedgerEntryRow[]
  total: number
}

function sha256File(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

/** 单行 meta upsert：行不存在则插入（首刷即失败/缺失的场景），存在则更新。 */
function upsertMeta(db: DrizzleDb, patch: Partial<typeof ledgerMeta.$inferInsert> & { id: number }): void {
  const existing = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
  if (existing) {
    db.update(ledgerMeta).set(patch).where(eq(ledgerMeta.id, 1)).run()
  } else {
    db.insert(ledgerMeta).values({ ...patch, ledgerPath: patch.ledgerPath ?? '' }).run()
  }
}

/**
 * 索引重建管线（数据流铁律：先校验 → 通过才重建；失败保持旧索引）：
 * 1. 文件不存在 → status='missing'
 * 2. hash 变更检测：与 ledger_meta 缓存相同 → 跳过（changed=false）
 * 3. parse_entries 校验：errors 非空 → status='error'，不重建
 * 4. 事务：清空 postings/entries → 全量插入 → 更新 ledger_meta
 * 注意：M3 的「增量」= 变更检测跳过；解析与重建本身是全量的（引擎无状态）。
 */
export async function refreshIndex(
  db: DrizzleDb,
  engine: PythonSvc,
  ledgerPath: string
): Promise<RefreshResult> {
  let fileHash = ''
  let mtimeMs = 0
  try {
    fileHash = sha256File(ledgerPath)
    mtimeMs = statSync(ledgerPath).mtimeMs
  } catch {
    upsertMeta(db, { id: 1, ledgerPath, status: 'missing', updatedAt: Date.now() })
    return { changed: true, status: 'missing', entryCount: 0, errorCount: 0 }
  }

  const meta = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
  if (meta?.fileHash === fileHash && meta.status !== 'missing') {
    return {
      changed: false,
      status: meta.status,
      entryCount: meta.entryCount,
      errorCount: meta.errorCount
    }
  }

  let parsed
  try {
    parsed = await engine.parseEntries(ledgerPath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    upsertMeta(db, { id: 1, ledgerPath, status: 'error', lastError: message, updatedAt: Date.now() })
    const stale = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
    return {
      changed: true,
      status: 'error',
      entryCount: stale?.entryCount ?? 0,
      errorCount: stale?.errorCount ?? 0,
      message
    }
  }

  if (parsed.errors.length > 0) {
    const message = parsed.errors.map((e) => e.message).join('; ')
    upsertMeta(db, {
      id: 1,
      ledgerPath,
      status: 'error',
      lastError: message,
      errorCount: parsed.errors.length,
      updatedAt: Date.now()
    })
    const stale = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
    return {
      changed: true,
      status: 'error',
      entryCount: stale?.entryCount ?? 0,
      errorCount: parsed.errors.length,
      message
    }
  }

  // 事务只重建 entries/postings；meta 在事务成功后单独 upsert（事务失败则不更新 meta，
  // 索引整体保持旧状态；两步间窗口毫秒级且索引可随时重建，可接受）
  const tx = db.transaction((drizzle) => {
    drizzle.delete(postings).run()
    drizzle.delete(entries).run()
    for (const entry of parsed.entries) {
      const inserted = drizzle
        .insert(entries)
        .values({
          type: entry.type as string,
          date: entry.date as string,
          flag: (entry.flag as string | null) ?? null,
          payee: (entry.payee as string | null) ?? null,
          narration: (entry.narration as string | null) ?? null,
          account: (entry.account as string | null) ?? null,
          lineno: (entry.lineno as number | null) ?? null
        })
        .returning()
        .get()
      for (const p of (entry.postings as Array<Record<string, unknown>> | undefined) ?? []) {
        drizzle
          .insert(postings)
          .values({
            entryId: inserted.id,
            account: p.account as string,
            unitsNumber: p.units_number as string,
            unitsCurrency: p.units_currency as string,
            costNumber: (p.cost_number as string | null) ?? null,
            costCurrency: (p.cost_currency as string | null) ?? null
          })
          .run()
      }
    }
  })
  tx.run()

  upsertMeta(db, {
    id: 1,
    ledgerPath,
    title: parsed.options.title as string | null,
    operatingCurrency: JSON.stringify(parsed.options.operating_currency ?? []),
    mtimeMs,
    fileHash,
    entryCount: parsed.entries.length,
    errorCount: 0,
    status: 'ok',
    lastError: null,
    updatedAt: Date.now()
  })

  return {
    changed: true,
    status: 'ok',
    entryCount: parsed.entries.length,
    errorCount: 0
  }
}

export function getLedgerStatus(db: DrizzleDb): LedgerStatus | null {
  const meta = db.select().from(ledgerMeta).where(eq(ledgerMeta.id, 1)).get()
  if (!meta) return null
  return {
    path: meta.ledgerPath,
    title: meta.title,
    operatingCurrency: parseJsonArray(meta.operatingCurrency),
    entryCount: meta.entryCount,
    errorCount: meta.errorCount,
    status: meta.status,
    lastError: meta.lastError,
    updatedAt: meta.updatedAt
  }
}

export function listEntries(db: DrizzleDb, limit: number, offset: number): ListEntriesResult {
  // total 用全表计数：M3 账本量级小可接受；大账本（>5 万笔）优化点见 roadmap 待定项
  const total = db.select().from(entries).all().length
  const rows = db
    .select()
    .from(entries)
    .orderBy((t) => [t.date.asc(), t.id.asc()])
    .limit(limit)
    .offset(offset)
    .all()
  return { entries: rows as LedgerEntryRow[], total }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}
```

注意：`db.transaction` 在 drizzle better-sqlite3 驱动下同步执行，`refreshIndex` 中的 `await` 都在事务外（RPC 先行）；事务内纯同步插入。

- [ ] **Step 4: 运行确认通过（绿）**

Run: `npm run test:unit -- src/main/index-builder.test.ts`
Expected: PASS（6 个用例；含真实引擎 spawn，测试串行执行）

- [ ] **Step 5: Commit**

```bash
git add src/main/index-builder.ts src/main/index-builder.test.ts
git commit -m "feat: 索引重建管线（hash 变更检测 + 校验门 + 事务重建）（M3）
"
```

---

### Task 5: IPC 骨架（shared 契约 → preload 白名单 → main handlers）

**Files:**
- Modify: `src/shared/ipc.ts`（通道 + 业务类型，re-export index-builder 类型）
- Modify: `src/shared/api.ts`（`BeanWiseApi` 扩展三个通道方法）
- Modify: `src/preload/index.ts`（contextBridge 暴露白名单）
- Create: `src/main/ipc-handlers.ts`
- Create: `src/main/ipc-handlers.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `refreshIndex` / `getLedgerStatus` / `listEntries` 与类型；`src/shared/ipc.ts` 既有 `IpcChannel`
- Produces: 通道定稿（Global Constraints「IPC 契约」）：`ledger:refresh-index` / `ledger:status` / `ledger:list-entries`；`registerLedgerHandlers(ipc, deps)`（ipc 为可注入 registrar——`{handle(channel, listener)}`，真实传入 `electron.ipcMain`，测试注入 mock）；渲染进程 API 面 `refreshLedgerIndex() / getLedgerStatus() / listLedgerEntries(params)`——Task 6 主进程接线与 Task 7 验收面板/E2E 的调用面

- [ ] **Step 1: 写 shared 契约（实现）**

`src/shared/ipc.ts` 整体替换为：

```ts
/**
 * IPC 通道契约（唯一来源）。命名规范：{domain}:{action} 小写 kebab，
 * 见 technical-proposal/implementation-roadmap.md「IPC 契约」。
 * M3 定稿：ledger 域三通道；业务类型在 src/main/index-builder.ts 定义并在此 re-export，
 * 保证「类型唯一来源」不被破坏（preload / renderer / main 共用）。
 */
export type IpcChannel = 'ledger:refresh-index' | 'ledger:status' | 'ledger:list-entries'

export type {
  LedgerEntryRow,
  LedgerIndexStatus,
  LedgerStatus,
  ListEntriesParams,
  ListEntriesResult,
  RefreshResult
} from '../main/index-builder'
```

- [ ] **Step 2: 扩展 preload API 类型（实现）**

`src/shared/api.ts` 整体替换为：

```ts
import type { LedgerStatus, ListEntriesParams, ListEntriesResult, RefreshResult } from './ipc'

/** Preload 暴露给渲染进程的白名单 API 形状（M3 扩展 ledger 域三方法） */
export interface BeanWiseApi {
  appName: string
  /** 触发索引重建（主进程持有账本路径，渲染进程不传路径——防目录穿越） */
  refreshLedgerIndex(): Promise<RefreshResult>
  getLedgerStatus(): Promise<LedgerStatus | null>
  listLedgerEntries(params: ListEntriesParams): Promise<ListEntriesResult>
}
```

- [ ] **Step 3: 写 handlers 测试（红）**

`src/main/ipc-handlers.test.ts`：

```ts
import { copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDrizzle, openDatabase } from './db'
import { registerLedgerHandlers, type IpcRegistrar } from './ipc-handlers'
import { PythonSvc } from './python-svc'

const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

describe('IPC handlers（M3）', () => {
  let db: ReturnType<typeof createDrizzle>
  let engine: PythonSvc
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let workFile: string

  beforeAll(async () => {
    // 注意：handlers 消费 DrizzleDb（Task 4 实测：raw Database 无 .select()，必须 createDrizzle 包装）
    db = createDrizzle(openDatabase(':memory:'))
    engine = new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] })
    await engine.start()
    workFile = join(tmpdir(), `beanwise-m3-ipc-${process.pid}.beancount`)
    copyFileSync(FIXTURE, workFile)

    const ipc: IpcRegistrar = {
      handle: (channel, listener) => {
        handlers[channel] = listener as (...args: unknown[]) => unknown
      }
    }
    handlers = {}
    registerLedgerHandlers(ipc, { db, engine, ledgerPath: workFile })
  })
  afterAll(async () => {
    await engine.stop()
    db.close()
  })

  it('ledger:refresh-index → ok + 5 entries；ledger:status 一致', async () => {
    const result = (await handlers['ledger:refresh-index']()) as { status: string; entryCount: number }
    expect(result.status).toBe('ok')
    expect(result.entryCount).toBe(5)

    const status = (await handlers['ledger:status']()) as { path: string; status: string }
    expect(status.path).toBe(workFile)
    expect(status.status).toBe('ok')
  }, 30_000)

  it('ledger:list-entries 默认分页与非法入参拒绝', async () => {
    const listed = (await handlers['ledger:list-entries'](undefined)) as {
      entries: Array<{ narration: string | null }>
      total: number
    }
    expect(listed.total).toBe(5)
    // 同 Task 4：fixture 单字符串日期行解析为 narration（Task 1 实测）
    expect(listed.entries[0].narration).toBe('Breakfast')

    await expect(handlers['ledger:list-entries']({ limit: -1 })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({ offset: -5 })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({ limit: 5000 })).rejects.toThrow()
    await expect(handlers['ledger:list-entries']({ limit: '100' })).rejects.toThrow()
  }, 30_000)
})
```

- [ ] **Step 4: 运行确认失败（红）**

Run: `npm run test:unit -- src/main/ipc-handlers.test.ts`
Expected: FAIL——`Cannot find module './ipc-handlers'`

- [ ] **Step 5: 写 handlers（实现）**

`src/main/ipc-handlers.ts`：

```ts
import type { ListEntriesParams, RefreshResult } from '../shared/ipc'
import type { DrizzleDb } from './db'
import { getLedgerStatus, listEntries, refreshIndex } from './index-builder'
import type { PythonSvc } from './python-svc'

/** 可注入的 IPC 注册器（测试传 mock，主进程传 electron.ipcMain） */
export interface IpcRegistrar {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
}

export interface LedgerDeps {
  db: DrizzleDb
  engine: PythonSvc
  /** 账本文件路径（主进程持有，渲染进程不传路径——防目录穿越） */
  ledgerPath: string
}

const MAX_LIMIT = 1_000
const DEFAULT_LIMIT = 100

function validateListParams(params: unknown): { limit: number; offset: number } {
  const raw = (params ?? {}) as Partial<ListEntriesParams>
  if (raw.limit !== undefined && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_LIMIT)) {
    throw new Error(`limit 必须是 1~${MAX_LIMIT} 的整数`)
  }
  if (raw.offset !== undefined && (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0)) {
    throw new Error('offset 必须是非负整数')
  }
  return {
    limit: raw.limit ?? DEFAULT_LIMIT,
    offset: raw.offset ?? 0
  }
}

/** 注册 ledger 域 IPC 通道（roadmap「IPC 契约」：类型唯一来源 ipc.ts → preload 白名单 → main handler） */
export function registerLedgerHandlers(ipc: IpcRegistrar, deps: LedgerDeps): void {
  ipc.handle('ledger:refresh-index', async (): Promise<RefreshResult> => {
    return refreshIndex(deps.db, deps.engine, deps.ledgerPath)
  })

  ipc.handle('ledger:status', () => {
    return getLedgerStatus(deps.db)
  })

  ipc.handle('ledger:list-entries', (_event: unknown, params: unknown) => {
    const { limit, offset } = validateListParams(params)
    return listEntries(deps.db, limit, offset)
  })
}
```

- [ ] **Step 6: preload 暴露白名单（实现）**

`src/preload/index.ts` 整体替换为：

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { APP_NAME } from '../shared/app'
import type { BeanWiseApi } from '../shared/api'
import type { ListEntriesParams } from '../shared/ipc'

const api: BeanWiseApi = {
  appName: APP_NAME,
  refreshLedgerIndex: () => ipcRenderer.invoke('ledger:refresh-index'),
  getLedgerStatus: () => ipcRenderer.invoke('ledger:status'),
  listLedgerEntries: (params: ListEntriesParams) => ipcRenderer.invoke('ledger:list-entries', params)
}

contextBridge.exposeInMainWorld('beanwise', api)
```

- [ ] **Step 7: 运行确认通过（绿）**

Run: `npm run test:unit -- src/main/ipc-handlers.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 8: 回归 + typecheck**

Run: `npm run typecheck && npm run test:unit`
Expected: typecheck 0 错误；vitest 全绿（Task 4 后 17 + 本文件 2 = 19 passed）

- [ ] **Step 9: Commit**

```bash
git add src/shared/ipc.ts src/shared/api.ts src/preload/index.ts src/main/ipc-handlers.ts src/main/ipc-handlers.test.ts
git commit -m "feat: 3 层 IPC 骨架（ledger 域三通道 + preload 白名单 + handler 校验）（M3）
"
```

---

### Task 6: 主进程接线（CSP 钩子 + PythonSvc/DB 创建 + handler 注册 + 生命周期）

**Files:**
- Create: `src/main/csp.ts`（M2 交接项「CSP 测试钩子」：CSP 常量与注入逻辑抽出，可单测）
- Create: `src/main/csp.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: Task 2 的 `openDatabase` / `createDrizzle`；Task 3 的 `PythonSvc`；Task 5 的 `registerLedgerHandlers`；M2 的 `dist-python/beancount-engine.exe`（打包定位点，`electron-builder.yml` extraResources `to: python/`）
- Produces: `CSP_PROD / CSP_DEV` 常量与 `applyCsp(isPackaged)`（`csp.ts`，可单测——M2 交接「生产 CSP 无自动化回归」闭环）；应用启动链路（app ready → 引擎+DB → handler 注册 → 初始刷新）、`before-quit` 优雅关闭——Task 7 E2E 的可启动应用

- [ ] **Step 1: 写 CSP 测试（红）**

`src/main/csp.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { CSP_DEV, CSP_PROD } from './csp'

describe('CSP 策略（M2 交接钩子，CLAUDE.md 约束 #8）', () => {
  it('生产 CSP：default-src 仅 self，无 unsafe-inline / unsafe-eval / remote 源', () => {
    expect(CSP_PROD).toContain("default-src 'self'")
    expect(CSP_PROD).not.toMatch(/unsafe-inline/)
    expect(CSP_PROD).not.toMatch(/unsafe-eval/)
    expect(CSP_PROD).not.toMatch(/https?:\/\//)
  })

  it('开发 CSP：script/style 放行 unsafe-inline（react-refresh/vite 内联），connect-src 放行 HMR WebSocket', () => {
    expect(CSP_DEV).toMatch(/script-src 'self' 'unsafe-inline'/)
    expect(CSP_DEV).toMatch(/style-src 'self' 'unsafe-inline'/)
    expect(CSP_DEV).toMatch(/connect-src 'self' ws:\/\/localhost:\*/)
  })
})
```

- [ ] **Step 2: 运行确认失败（红）**

Run: `npm run test:unit -- src/main/csp.test.ts`
Expected: FAIL——`Cannot find module './csp'`

- [ ] **Step 3: 写 csp.ts（实现）**

`src/main/csp.ts`：

```ts
import { session } from 'electron'

export const CSP_PROD = "default-src 'self'"
// 开发模式：electron-vite HMR 需要 react-refresh 内联脚本（unsafe-inline）与 WebSocket
export const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*"

/** 注入 CSP 响应头；isPackaged 注入（可测，主进程传 app.isPackaged） */
export function applyCsp(isPackaged: boolean): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isPackaged ? CSP_PROD : CSP_DEV
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}
```

- [ ] **Step 4: 运行确认通过（绿）**

Run: `npm run test:unit -- src/main/csp.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 写主进程接线（实现）**

`src/main/index.ts` 整体替换为：

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
import { APP_NAME } from '../shared/app'
import { applyCsp } from './csp'
import { createDrizzle, openDatabase } from './db'
import { refreshIndex } from './index-builder'
import { registerLedgerHandlers } from './ipc-handlers'
import { PythonSvc } from './python-svc'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false // electron-vite ESM preload 需要；M3 安全评审再收紧（M1 遗留）
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * 引擎命令解析（roadmap「Node ↔ Python」+ M2 交接说明）：
 * 开发模式调本机解释器（BEANWISE_PYTHON_CMD 可覆盖，默认 Windows py -3.11 / 其他 python3）；
 * 打包后从 extraResources 定位 resources/python/beancount-engine.exe。
 */
function resolveEngineCommand(): string[] {
  if (app.isPackaged) {
    return [join(process.resourcesPath, 'python/beancount-engine.exe'), '--stdio']
  }
  const override = process.env['BEANWISE_PYTHON_CMD']?.split(' ')
  if (override?.length) return [...override, resolve('python/service.py'), '--stdio']
  return process.platform === 'win32'
    ? ['py', '-3.11', resolve('python/service.py'), '--stdio']
    : ['python3', resolve('python/service.py'), '--stdio']
}

/** 账本路径：环境变量优先（测试/E2E 注入），默认 documents/beanwise/main.beancount */
function resolveLedgerPath(): string {
  return process.env['BEANWISE_LEDGER_PATH'] ?? join(app.getPath('documents'), 'beanwise', 'main.beancount')
}

let pythonSvc: PythonSvc | null = null
let quitHandled = false

app.whenReady().then(() => {
  applyCsp(app.isPackaged)

  pythonSvc = new PythonSvc({ command: resolveEngineCommand() })
  const db = createDrizzle(openDatabase(join(app.getPath('userData'), 'beanwise.db')))
  registerLedgerHandlers(ipcMain, { db, engine: pythonSvc, ledgerPath: resolveLedgerPath() })

  // 启动初始刷新（fire-and-forget：失败不影响窗口创建，状态由 ledger:status 暴露）
  void pythonSvc
    .start()
    .then(() => refreshIndex(db, pythonSvc!, resolveLedgerPath()))
    .catch((err: unknown) => {
      console.error('[BeanWise] 初始索引刷新失败:', err)
    })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 平台仅 Windows（2026-08 定稿）：所有窗口关闭即退出
app.on('window-all-closed', () => {
  app.quit()
})

// before-quit 优雅关闭：shutdown RPC → 进程退出 0；二次触发直接放行
app.on('before-quit', (event) => {
  if (quitHandled) return
  quitHandled = true
  event.preventDefault()
  void (async () => {
    if (pythonSvc) await pythonSvc.stop()
    app.quit()
  })()
})
```

- [ ] **Step 6: 手动验证（dev 模式启动）**

Run:
```bash
BEANWISE_LEDGER_PATH="$(pwd)/python/tests/fixtures/main.beancount" npm run dev
```
Expected: 应用窗口打开，dev 控制台无未捕获异常；关闭窗口后进程正常退出（PythonSvc 优雅关闭，无残留 py 进程）。验证完按 Ctrl+C 退出。

- [ ] **Step 7: 回归 + typecheck**

Run: `npm run typecheck && npm run test:unit`
Expected: typecheck 0 错误；vitest 21 passed

- [ ] **Step 8: Commit**

```bash
git add src/main/csp.ts src/main/csp.test.ts src/main/index.ts
git commit -m "feat: 主进程接线（CSP 钩子 + 引擎/DB 初始化 + handler 注册 + 优雅关闭）（M3）
"
```

---

### Task 7: 验收面板（极简只读索引状态）+ E2E

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Create: `e2e/ledger-index.spec.ts`

**Interfaces:**
- Consumes: Task 5 的渲染进程 API 面（`refreshLedgerIndex` / `getLedgerStatus` / `listLedgerEntries`）；Task 6 的完整启动链路
- Produces: M3 绿灯验收载体（渲染进程可见索引状态与条目）；E2E 自动化验收（`BEANWISE_LEDGER_PATH` 注入 fixture → 刷新 → 断言索引可见）

- [ ] **Step 1: 写验收面板（实现）**

`src/renderer/src/App.tsx` 整体替换为：

```tsx
import { useEffect, useState } from 'react'
import type { LedgerEntryRow, LedgerStatus } from '../../shared/ipc'

// M3 验收面板：只读索引状态展示（非业务 UI，M4 起由正式界面取代）。
// 不引入 antd（M4 依赖），保持 M3 依赖最小。
export default function App() {
  const [status, setStatus] = useState<LedgerStatus | null>(null)
  const [entries, setEntries] = useState<LedgerEntryRow[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = async () => {
    const [s, r] = await Promise.all([
      window.beanwise.getLedgerStatus(),
      window.beanwise.listLedgerEntries({ limit: 200 })
    ])
    setStatus(s)
    setEntries(r.entries)
  }

  useEffect(() => {
    void load().catch((err: unknown) => setMessage(String(err)))
  }, [])

  const refresh = async () => {
    setRefreshing(true)
    setMessage(null)
    try {
      const result = await window.beanwise.refreshLedgerIndex()
      if (result.status === 'error') setMessage(result.message ?? '索引重建失败')
      await load()
    } catch (err) {
      setMessage(String(err))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <main className="app">
      <h1>{window.beanwise.appName}</h1>
      <section id="ledger-status">
        <h2>索引状态</h2>
        {status ? (
          <ul className="status-list">
            <li>路径：<code id="ledger-path">{status.path}</code></li>
            <li>标题：{status.title ?? '—'}</li>
            <li>货币：{status.operatingCurrency.join(', ') || '—'}</li>
            <li>条目数：<span id="entry-count">{status.entryCount}</span></li>
            <li>错误数：<span id="error-count">{status.errorCount}</span></li>
            <li>状态：<span id="index-status">{status.status}</span></li>
            {status.lastError && <li className="error-text">错误：{status.lastError}</li>}
            <li>更新时间：{status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—'}</li>
          </ul>
        ) : (
          <p>尚未索引</p>
        )}
        {message && <p className="error-text" id="refresh-message">{message}</p>}
        <button id="refresh-btn" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? '刷新中…' : '刷新索引'}
        </button>
      </section>
      <section id="ledger-entries">
        <h2>条目（{entries.length}）</h2>
        <ul className="entry-list">
          {entries.map((entry) => (
            <li key={entry.id} data-type={entry.type}>
              <span className="entry-date">{entry.date}</span>
              <span className="entry-type">{entry.type}</span>
              {entry.payee && <span className="entry-payee">{entry.payee}</span>}
              {entry.narration && <span className="entry-narration">{entry.narration}</span>}
              {entry.account && <span className="entry-account">{entry.account}</span>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
```

- [ ] **Step 2: 补样式**

`src/renderer/src/styles.css` 追加：

```css
.app { max-width: 900px; margin: 0 auto; padding: 24px; font-family: system-ui, sans-serif; }
.status-list, .entry-list { list-style: none; padding: 0; }
.status-list li { margin: 4px 0; }
.entry-list li { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px solid #eee; }
.entry-date { color: #666; }
.entry-type { color: #888; }
.entry-payee { font-weight: 600; }
.entry-account { color: #666; }
.error-text { color: #c00; }
```

- [ ] **Step 3: 写 E2E（红）**

`e2e/ledger-index.spec.ts`：

```ts
import { _electron as electron, expect, test } from '@playwright/test'
import { resolve } from 'node:path'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']
// 与 index-builder 测试同源的合法账本 fixture（3 open + 2 交易 = 5 entries）
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

test('M3 绿灯：刷新索引后条目可见', async () => {
  const app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, BEANWISE_LEDGER_PATH: FIXTURE }
  })
  const win = await app.firstWindow()

  const refreshBtn = win.getByRole('button', { name: '刷新索引' })
  await expect(refreshBtn).toBeVisible()
  await refreshBtn.click()

  // 索引可见：条目数 5、状态 ok、Breakfast 交易在列表中
  await expect(win.locator('#entry-count')).toHaveText('5')
  await expect(win.locator('#index-status')).toHaveText('ok')
  await expect(win.locator('#ledger-entries .entry-list li', { hasText: 'Breakfast' })).toBeVisible()

  await app.close()
})
```

- [ ] **Step 4: 运行确认通过（绿）**

Run: `npm run test:e2e`
Expected: e2e 2 个用例全过（原 smoke + 本用例；首次 Electron 启动 + Python 引擎 1~3s 属预期，用例超时 60s 足够）

- [ ] **Step 5: 回归 + typecheck**

Run: `npm run typecheck && npm run test:unit`
Expected: typecheck 0 错误；vitest 21 passed

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/styles.css e2e/ledger-index.spec.ts
git commit -m "feat: 极简索引验收面板 + M3 绿灯 E2E（M3）
"
```

---

### Task 8: 文档同步 + M3 绿灯验收

**Files:**
- Modify: `technical-proposal/implementation-roadmap.md`
- 无代码变更（仅验证与文档）

**Interfaces:**
- Consumes: Task 1-7 全部产物
- Produces: roadmap 契约同步（`parse_entries` 方法 + M3 IPC 通道表）+ M3 绿灯验收记录

- [ ] **Step 1: roadmap 同步「Node ↔ Python」方法表**

`technical-proposal/implementation-roadmap.md` 的「Node ↔ Python（stdio JSON-RPC）」节方法清单改为：

```markdown
- JSON-RPC 2.0，JSONL 逐行（`\n` 分隔）；方法：`ping` / `parse_file` / `parse_entries` / `validate` / `query` / `render_report` / `shutdown`
```

（`parse_entries` 于 M3 新增：结构化条目序列化，SQLite 索引数据源，见 `docs/superpowers/plans/2026-08-09-m3-ipc-sqlite-index.md` Task 1 契约。）

- [ ] **Step 2: roadmap 同步「IPC 契约」节**

「IPC 契约」节追加 M3 定稿通道：

```markdown
- M3 定稿通道（类型唯一来源 `src/shared/ipc.ts`，M4-M8 复用）：

  | 通道 | params | result 要点 |
  |---|---|---|
  | `ledger:refresh-index` | 无（路径主进程持有） | `{changed, status: ok\|error\|missing, entryCount, errorCount, message?}` |
  | `ledger:status` | 无 | `LedgerStatus \| null`（path/title/operatingCurrency[]/entryCount/errorCount/status/lastError/updatedAt） |
  | `ledger:list-entries` | `{limit? 默认100上限1000, offset? 默认0}` | `{entries: [{id,type,date,flag,payee,narration,account,lineno}], total}` |
```

- [ ] **Step 3: 本机全量验收**

Run:
```bash
py -3.11 -m pytest python/tests
npm run typecheck
npm run test:unit
```
Expected: pytest 23 passed（基线 19 + parse_entries 3 + RPC 级缺参用例 1）；typecheck 0 错误；vitest 24 passed

- [ ] **Step 4: E2E 验收 + 手工验收演练**

Run: `npm run test:e2e`
Expected: 2 个用例全过。

手工验收（M3 绿灯验收原文「手工写入一笔交易 → 索引可见」）：
1. `BEANWISE_LEDGER_PATH="$(pwd)/python/tests/fixtures/main.beancount" npm run dev` 启动
2. 用编辑器向该账本文件追加一笔合法交易（如 `2026-01-05 * "Dinner"` + 两个 posting）
3. 切回应用点「刷新索引」→ 条目数从 5 变 6，新条目出现在列表
4. 写入一笔未配平交易再刷新 → 状态 error、错误信息展示、旧索引保持（条目数仍 6）
5. 关闭应用：进程正常退出，无残留 `py`/`beancount-engine` 进程（任务管理器验证）

- [ ] **Step 5: Push 并验证 CI（M3 绿灯验收）**

Run:
```bash
git push origin main
```
Expected: GitHub Actions 三 job 全绿——
- `test`（ubuntu）：typecheck + Vitest（24 用例，含 PythonSvc/index-builder/ipc-handlers 真实引擎测试，pip 已前置）+ pytest 23 passed
- `e2e`（ubuntu，xvfb）：smoke + ledger-index 2 用例（`npm ci` 触发 postinstall 编译 better-sqlite3 for Electron，runner 自带工具链）
- `build`（windows-latest）：PyInstaller + `dist:win`（asarUnpack 已含 better-sqlite3）

若 e2e/build 失败，优先排查：better-sqlite3 原生模块编译（node-gyp 日志、`ELECTRON_MIRROR` 镜像）、Windows `%TEMP%\eb-dl-*.lock` 与孤儿进程（CLAUDE.md「常见坑」）。

- [ ] **Step 6: Commit 文档同步**

```bash
git add technical-proposal/implementation-roadmap.md
git commit -m "docs: roadmap 同步 parse_entries 方法与 M3 IPC 通道契约（M3）
"
```

---

## M3 绿灯验收汇总

| 验收项 | 命令 / 位置 | 判定 |
|---|---|---|
| Python 引擎测试 | `py -3.11 -m pytest python/tests` | 23 passed（基线 19 + parse_entries 3 + RPC 缺参 1） |
| TypeScript 严格检查 | `npm run typecheck` | 0 错误 |
| 前端单测 | `npm run test:unit` | 24 passed（基线 4 + DB 3 + PythonSvc 6 + index-builder 7 + ipc-handlers 2 + CSP 2） |
| E2E | `npm run test:e2e` | smoke + ledger-index 2 用例全过 |
| 手工验收 | dev 启动 + 编辑账本 + 刷新 | 写入一笔交易 → 索引可见（条目数 +1）；坏账本 → error 且旧索引保持 |
| 生命周期 | 关闭应用 | 无残留 py/beancount-engine 进程 |
| 原生模块 | package.json / electron-builder.yml | better-sqlite3 经 postinstall rebuild + asarUnpack |
| 契约同步 | implementation-roadmap.md | parse_entries 方法 + M3 IPC 通道表 |
| CI | GitHub Actions test/e2e/build | 3 jobs green |

## M4 交接说明（不在本计划内）

- **索引数据面**：`ledger_meta` / `entries` / `postings` 三表已定稿（见本计划 Global Constraints「数据库契约」）；`postings` 含 account / units_number(TEXT) / units_currency / cost 列——M8 报表聚合直接 SQL 查询即可，无需改表
- **校验错误入口**：`ledger:status` 的 `lastError`（汇总字符串）+ `errorCount` 已暴露；M4 录入表单的错误展示可直接复用；若需要逐条错误（含 lineno），M4 再扩展 `ledger:status` 或新增通道（记录在案的扩展点）
- **账本路径**：主进程 `resolveLedgerPath()`（`BEANWISE_LEDGER_PATH` 优先，默认 `documents/beanwise/main.beancount`）；M4 录入链路直接落盘该路径；骨架文件自动创建是 M4 待办
- **索引触发面**：`ledger:refresh-index`（手动）+ 启动自动刷新已就绪；fs.watch 自动监听未做（M3 边界）——M4 录入保存与 M5 Monaco 保存链路主动调用 refresh
- **扩展点**：`query` / `render_report` 的 Node 侧封装未做（M8）；`list-entries` 未返回 postings（M4 列表若需要金额，扩展该通道返回结构，注意与 `LedgerEntryRow` 类型同步）
- **已知边界**：`refreshIndex` 中 hash 变更检测为全量读文件计算（账本 <10MB 无性能问题，大账本基准是 ADR 待定项）；WAL 模式多实例并发访问未处理（单进程应用，M6 同步会另起 git 操作但不触库）
