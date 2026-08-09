# M5 Monaco 编辑器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地账本编辑器视图：Monaco 打开账本 → beancount 语法高亮 → 编辑 → 保存（tmp 校验 + rename 原子替换）→ 校验提示 → 索引联动；保存时检测外部修改冲突并用 DiffEditor 展示差异。绿灯验收：打开账本 → beancount 高亮 → 编辑保存 → 校验提示。

**Architecture:** 裸 `monaco-editor@^0.56.0` + Vite `?worker`（worker 独立 chunk，`worker-src 'self'` 加载）+ 自研 monarch 语言定义。新增 `ledger:read-file` / `ledger:save-file` 两通道：主进程持有路径，read 返回内容+sha256 指纹；save 先比对 expectedFingerprint（外部修改冲突检测，同一次读取快照返回 diskContent/diskFingerprint）→ 写同目录 `.m5tmp` → `parse_entries` 校验 → 通过则 `renameSync` 原子替换 → `refreshIndex`（M3 管线）。渲染端：Sider 加「编辑器」项，三视图 CSS display 保活；EditorView + useEditorSave（状态机在 ledgerStore 扩展，hook 仅选择器 + 动作绑定，node 可单测）；冲突面板用 `monaco.editor.createDiffEditor` 双 model 组合（为 M6 三路合并铺路）。校验失败**不落盘**（tmp 删除、原文件不动），比 M4 的「写后 truncate 回滚」更干净。

**Tech Stack:** monaco-editor 0.56（裸包）· Vite `?worker` · monarch tokenizer · antd（Button/Tag/Alert/Empty）· zustand（ledgerStore 扩展）· Node fs（readFile/writeFile/rename/rm 同步 API）

## Global Constraints

- **版本与平台**：Windows-only；Electron 43 · React 19.2 · Node 22（CI）· Python 3.11（本机 `py -3.11`，`BEANWISE_PYTHON_CMD` 可覆盖）；`npm run dev` 前 `env -u ELECTRON_RUN_AS_NODE`
- **Monaco 集成（M5 定稿）**：`monaco-editor@^0.56.0` 为 dependencies（vite 打包进 renderer 产物，非 externalize）；worker 经 `monaco-editor/esm/vs/editor/editor.worker?worker` 导入，`self.MonacoEnvironment.getWorker` 接线；CSS 导入 `monaco-editor/min/vs/editor/editor.main.css`；**禁 CDN / blob / unsafe-eval**
- **CSP 修订（Task 1）**：生产 `default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`；开发 `...; worker-src 'self'`（显式对称）；`csp.ts` + `csp.test.ts` 同步（现有断言「不含 script-src / unsafe-eval / http」仍须成立）
- **新增 IPC 契约（Task 2 定稿，类型唯一来源 `src/shared/ipc.ts`）**：
  - `ledger:read-file`：无参 → `ReadFileResult` `{ok, content?, fingerprint?, message?}`；ENOENT → `{ok:false, message:'账本文件不存在，请先在录入视图录一笔创建'}`
  - `ledger:save-file`：`{content: string, expectedFingerprint: string}` → `SaveFileResult` `{ok, conflict?, diskContent?, diskFingerprint?, fingerprint?, status?, entryCount?, errorCount?, message?}`；conflict 时 diskContent/diskFingerprint 为**同一次读取快照**
  - `fingerprint` = 文件 sha256 hex（复用 `index-builder.ts` 的 `sha256File`，改为 export；冲突检测用 `createHash('sha256').update(diskContent)` 免二次读盘）
  - 入参校验：content 为 string 且 ≤20MB（`Buffer.byteLength`）；expectedFingerprint 匹配 `/^[a-f0-9]{64}$/`；非法 throw 中文 Error
- **保存管线（Task 2，定稿语义）**：指纹一致 → `rmSync(tmp, {force:true})`（清崩溃残留）→ `writeFileSync(tmp, content)` → `engine.parseEntries(tmp)`（复用 M3 引擎，tmp 路径合法）→ errors 非空：`rmSync(tmp)` 返回 `{ok:false, message}`（原文件不动）→ 通过：`renameSync(tmp, ledgerPath)`（Windows 上覆盖已存在文件，MoveFileExW 语义）→ `refreshIndex` → 返回 `{ok:true, fingerprint: sha256File(ledgerPath), status, entryCount, errorCount}`（status==='error' 时附 message，文件已合法替换可经 Header 重建索引恢复）
- **渲染端状态映射（spec §5 落地说明）**：store 持 `editorContent/editorOriginal/editorFingerprint/editorLoaded/editorMissing/editorSaving/editorConflict`；`dirty` 由 hook 派生（`content !== original && content !== null`）不入 store（避免双写不一致）；保存状态机逻辑放 **ledgerStore actions**（`saveEditorFile/forceSaveEditorFile/reloadEditorFile/continueEdit`），`useEditorSave` 仅做选择器+动作绑定——保证 node 环境可单测（zustand 无需 DOM）
- **渲染进程边界**：不直连 Python / SQLite / fs；preload 白名单加 `readLedgerFile` / `saveLedgerFile`；账本路径主进程持有
- **测试约定**：main 侧测试沿用 M3/M4 真实引擎模式（`py -3.11` + fixture 副本到 tmp；handler 注入式 IpcRegistrar，调用签名 `handlers[channel]({}, params)`）；renderer 侧 node 环境 + `vi.stubGlobal('window', {beanwise})` + `vi.mock('antd', ...)`；beancount-language 注入 monaco 对象（type-only import，运行时不依赖 monaco）
- **不做（M5 边界，roadmap 与 spec §10）**：错误定位到行；实时 lint；自动保存；「按日期重排」；三路合并 UI（M6）；主题切换；fs.watch 外部修改监听（检测时机 = 保存动作）
- **提交**：每个任务一个 commit，约定式前缀，中文消息（与 M1-M4 一致）；不附加任何 Co-Authored-By 署名

---

### Task 1: monaco-editor 依赖 + worker 接线 + CSP worker-src

**Files:**
- Modify: `package.json`（monaco-editor 依赖）
- Add: `src/renderer/src/monaco/setup.ts`（worker 接线 + CSS）
- Modify: `src/renderer/src/main.tsx`（首行区域导入 setup，**先于 App import**）
- Modify: `src/main/csp.ts`（CSP_PROD / CSP_DEV 加 worker-src）
- Modify: `src/main/csp.test.ts`（断言同步）

**Interfaces:**
- Consumes: M4 定稿 CSP（csp.ts 注入式、csp.test.ts 断言）
- Produces: Monaco 运行环境（worker 本地化，CSP 合规）；生产 CSP `worker-src 'self'`

- [ ] **Step 1: 安装依赖**
  ```bash
  npm i monaco-editor@^0.56.0
  ```
  postinstall 钩子会跑（better-sqlite3 检查），确认无 fail-loud 报错。

- [ ] **Step 2: worker 接线 + CSS（新建 `src/renderer/src/monaco/setup.ts`）**
  ```ts
  /**
   * M5：Monaco worker 接线——vite `?worker` 将 worker 打成独立 chunk，
   * new Worker(本地URL) 经 worker-src 'self' 加载（生产 CSP 禁 blob/remote/unsafe-eval）。
   * 必须在任何 monaco 编辑器创建前设置：main.tsx 在 App import 之前导入本文件。
   */
  import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
  import 'monaco-editor/min/vs/editor/editor.main.css'

  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker()
  }
  ```
  若 TS 报 `MonacoEnvironment` 不在 Window 上：改为 `(self as unknown as { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = {...}`。

- [ ] **Step 3: main.tsx 接线**
  `src/renderer/src/main.tsx`：现有第一行是 `import '@ant-design/v5-patch-for-react-19'`（M4，保持最顶）。在其后（**App import 之前**）加：
  ```ts
  import './monaco/setup'
  ```

- [ ] **Step 4: CSP 修订（csp.ts）**
  ```ts
  export const CSP_PROD = "default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'"
  export const CSP_DEV =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*; worker-src 'self'"
  ```

- [ ] **Step 5: csp.test.ts 断言同步**
  生产断言块追加：
  ```ts
  expect(CSP_PROD).toContain("worker-src 'self'")
  ```
  开发断言块追加：
  ```ts
  expect(CSP_DEV).toContain("worker-src 'self'")
  ```
  现有「不含 script-src / unsafe-eval / http」断言不动（仍成立）。

- [ ] **Step 6: 验证**
  `npm run typecheck` 绿；`npm run test:unit` 绿。

- [ ] **Step 7: Commit**
  ```bash
  git add package.json package-lock.json src/renderer/src/monaco/setup.ts src/renderer/src/main.tsx src/main/csp.ts src/main/csp.test.ts
  git commit -m "feat: monaco-editor 依赖 + worker 本地化接线 + CSP worker-src（M5-T1）"
  ```

---

### Task 2: IPC 契约扩展（read-file / save-file）+ 主进程 handler

**Files:**
- Modify: `src/shared/ipc.ts`（IpcChannel + ReadFileResult / SaveFileParams / SaveFileResult）
- Modify: `src/main/index-builder.ts`（`sha256File` 改 export，补 M5 注释）
- Modify: `src/shared/api.ts`（BeanWiseApi 加两方法）
- Modify: `src/preload/index.ts`（白名单两方法）
- Modify: `src/main/ipc-handlers.ts`（注册两通道 + 校验 + 保存管线）
- Add: `src/main/ipc-handlers-editor.test.ts`

**Interfaces:**
- Consumes: M3 `refreshIndex` / M4 `LedgerDeps`（db/engine/ledgerPath）；PythonSvc `parseEntries(path)` → `{entries, errors:[{type,message,lineno?}], options}`
- Produces: `readLedgerFile(): Promise<ReadFileResult>`、`saveLedgerFile(params: SaveFileParams): Promise<SaveFileResult>`（preload 白名单）；Task 4 视图与 store 的唯一数据入口

- [ ] **Step 1: 类型先行（src/shared/ipc.ts）**
  ```ts
  export type IpcChannel = 'ledger:refresh-index' | 'ledger:status' | 'ledger:list-entries'
    | 'ledger:add-entry' | 'ledger:list-accounts' | 'ledger:read-file' | 'ledger:save-file'

  /** ledger:read-file 结果（ENOENT → ok:false + message，编辑器 Empty 态） */
  export interface ReadFileResult {
    ok: boolean
    /** 文件全文（utf8） */
    content?: string
    /** 文件 sha256 hex（打开时基线，保存时比对） */
    fingerprint?: string
    message?: string
  }

  /** ledger:save-file 入参 */
  export interface SaveFileParams {
    content: string
    /** 打开时指纹（sha256 hex）：与磁盘现状不一致 → 外部修改冲突，拒绝落盘 */
    expectedFingerprint: string
  }

  /** ledger:save-file 结果 */
  export interface SaveFileResult {
    ok: boolean
    /** true = 外部修改冲突，未落盘；diskContent/diskFingerprint 为同一次读取快照 */
    conflict?: boolean
    diskContent?: string
    diskFingerprint?: string
    /** 保存成功后新文件指纹（渲染端更新基线） */
    fingerprint?: string
    status?: LedgerIndexStatus
    entryCount?: number
    errorCount?: number
    message?: string
  }
  ```

- [ ] **Step 2: 导出 sha256File（index-builder.ts）**
  `function sha256File(filename: string): string` → `export function sha256File(filename: string): string`（注释补：M5 编辑器保存链路复用）。

- [ ] **Step 3: 白名单接线（api.ts + preload/index.ts）**
  api.ts `BeanWiseApi` 加：
  ```ts
  /** 读账本全文（编辑器基线；路径主进程持有） */
  readLedgerFile(): Promise<ReadFileResult>
  /** 整文件覆盖保存：指纹比对 → tmp 校验 → rename 原子替换 → 索引重建 */
  saveLedgerFile(params: SaveFileParams): Promise<SaveFileResult>
  ```
  （顶部 import 类型 ReadFileResult / SaveFileParams / SaveFileResult。）
  preload/index.ts 的 api 对象加：
  ```ts
  readLedgerFile: () => ipcRenderer.invoke('ledger:read-file'),
  saveLedgerFile: (params: SaveFileParams) => ipcRenderer.invoke('ledger:save-file', params)
  ```
  （顶部 import 类型 SaveFileParams。）

- [ ] **Step 4: 主进程 handler（ipc-handlers.ts）**
  顶部 import 调整：
  ```ts
  import { createHash } from 'node:crypto'
  import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
  import type { AddEntryResult, ListAccountsResult, ListEntriesParams, ReadFileResult, RefreshResult, SaveFileParams, SaveFileResult } from '../shared/ipc'
  import { getLedgerStatus, listEntries, refreshIndex, sha256File } from './index-builder'
  ```
  模块级常量 + 校验函数（放在 `validateListParams` 之后）：
  ```ts
  const SHA256_RE = /^[a-f0-9]{64}$/
  const MAX_LEDGER_CONTENT_BYTES = 20 * 1024 * 1024

  function validateSaveParams(raw: unknown): SaveFileParams {
    const p = (raw ?? {}) as Partial<SaveFileParams>
    if (typeof p.content !== 'string') throw new Error('content 必须是字符串')
    if (Buffer.byteLength(p.content, 'utf8') > MAX_LEDGER_CONTENT_BYTES) {
      throw new Error('账本内容超过 20MB 上限')
    }
    if (typeof p.expectedFingerprint !== 'string' || !SHA256_RE.test(p.expectedFingerprint)) {
      throw new Error('expectedFingerprint 必须是 64 位小写 sha256 hex')
    }
    return { content: p.content, expectedFingerprint: p.expectedFingerprint }
  }
  ```
  `registerLedgerHandlers` 末尾追加两通道：
  ```ts
  // M5：读账本全文（渲染端编辑基线；ENOENT → ok:false，编辑器 Empty 态）
  ipc.handle('ledger:read-file', (): ReadFileResult => {
    try {
      const content = readFileSync(deps.ledgerPath, 'utf8')
      return { ok: true, content, fingerprint: sha256File(deps.ledgerPath) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, message: '账本文件不存在，请先在录入视图录一笔创建' }
      }
      throw err
    }
  })

  // M5：整文件覆盖保存——指纹比对（外部修改冲突检测）→ 写 tmp → parse 校验 → rename 原子替换
  // → 索引重建。校验失败不落盘（tmp 删除、原文件不动），比 M4 append 的「写后 truncate 回滚」更干净
  ipc.handle('ledger:save-file', async (_event: unknown, raw: unknown): Promise<SaveFileResult> => {
    const { content, expectedFingerprint } = validateSaveParams(raw)

    // 1. 外部修改冲突检测：同一次读取的快照（内容 + 指纹），无二次读取竞态
    let diskContent: string
    try {
      diskContent = readFileSync(deps.ledgerPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('账本文件不存在')
      throw err
    }
    const diskFingerprint = createHash('sha256').update(diskContent).digest('hex')
    if (diskFingerprint !== expectedFingerprint) {
      return { ok: false, conflict: true, diskContent, diskFingerprint }
    }

    // 2. 写同目录临时文件 → parse 校验（引擎无状态，tmp 路径合法）
    const tmpPath = `${deps.ledgerPath}.m5tmp`
    rmSync(tmpPath, { force: true }) // 清理上次崩溃残留（best-effort）
    writeFileSync(tmpPath, content, 'utf8')
    const parsed = await deps.engine.parseEntries(tmpPath)
    if (parsed.errors.length > 0) {
      rmSync(tmpPath, { force: true })
      return { ok: false, message: parsed.errors.map((e) => e.message).join('; ') }
    }

    // 3. rename 原子替换（Node on Windows：覆盖已存在文件）→ 索引重建（M3 管线）
    renameSync(tmpPath, deps.ledgerPath)
    const result = await refreshIndex(deps.db, deps.engine, deps.ledgerPath)
    return {
      ok: true,
      fingerprint: sha256File(deps.ledgerPath),
      status: result.status,
      entryCount: result.entryCount,
      errorCount: result.errorCount,
      ...(result.status === 'error' ? { message: result.message } : {})
    }
  })
  ```

- [ ] **Step 5: 单测（新增 src/main/ipc-handlers-editor.test.ts，沿用 M3 真实引擎模式）**
  ```ts
  import { existsSync, readFileSync, appendFileSync, copyFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join, resolve } from 'node:path'
  import { afterAll, beforeAll, describe, expect, it } from 'vitest'
  import { createDrizzle, openDatabase } from './db'
  import { registerLedgerHandlers, type IpcRegistrar } from './ipc-handlers'
  import { PythonSvc } from './python-svc'

  const PYTHON =
    process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
    (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
  const SERVICE = resolve('python/service.py')
  const FIXTURE = resolve('python/tests/fixtures/main.beancount')

  describe('IPC handlers M5（read-file / save-file）', () => {
    let db: ReturnType<typeof createDrizzle>
    let engine: PythonSvc
    let handlers: Record<string, (...args: unknown[]) => unknown>
    let workFile: string

    beforeAll(async () => {
      db = createDrizzle(openDatabase(':memory:'))
      engine = new PythonSvc({ command: [...PYTHON, SERVICE, '--stdio'] })
      await engine.start()
      workFile = join(tmpdir(), `beanwise-m5-ipc-${process.pid}.beancount`)
      copyFileSync(FIXTURE, workFile)
      const ipc: IpcRegistrar = { handle: (channel, listener) => { handlers[channel] = listener as (...args: unknown[]) => unknown } }
      handlers = {}
      registerLedgerHandlers(ipc, { db, engine, ledgerPath: workFile })
    })
    afterAll(async () => {
      await engine.stop()
      db.$client.close()
    })

    it('ledger:read-file → ok + 全文 + sha256 指纹', async () => {
      const r = (await handlers['ledger:read-file']()) as {
        ok: boolean; content: string; fingerprint: string
      }
      expect(r.ok).toBe(true)
      expect(r.content).toContain('Breakfast')
      expect(r.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    }, 30_000)

    it('ledger:save-file 成功：tmp+rename 原子替换 + 索引重建 + 返回新指纹', async () => {
      const read = (await handlers['ledger:read-file']()) as { content: string; fingerprint: string }
      const content =
        read.content +
        '2026-08-09 * "M5 单测" "保存链路"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -10.00 CNY\n'
      const result = (await handlers['ledger:save-file']({}, {
        content, expectedFingerprint: read.fingerprint
      })) as { ok: boolean; status: string; entryCount: number; fingerprint: string }
      expect(result.ok).toBe(true)
      expect(result.status).toBe('ok')
      expect(result.entryCount).toBe(6)
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(readFileSync(workFile, 'utf8')).toBe(content) // 文件被替换为保存内容
      expect(existsSync(`${workFile}.m5tmp`)).toBe(false)  // 无残留 tmp
    }, 30_000)

    it('ledger:save-file 冲突：外部修改 → conflict + 快照，不落盘', async () => {
      const read = (await handlers['ledger:read-file']()) as { content: string; fingerprint: string }
      appendFileSync(workFile,
        '\n2026-08-09 * "外部" "修改"\n  Expenses:Food  1.00 CNY\n  Assets:Bank:CNB  -1.00 CNY\n')
      const before = readFileSync(workFile, 'utf8')
      const result = (await handlers['ledger:save-file']({}, {
        content: 'totally different content', expectedFingerprint: read.fingerprint
      })) as { ok: boolean; conflict: boolean; diskContent: string; diskFingerprint: string }
      expect(result.ok).toBe(false)
      expect(result.conflict).toBe(true)
      expect(result.diskContent).toBe(before)
      expect(result.diskFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(readFileSync(workFile, 'utf8')).toBe(before) // 未落盘
    }, 30_000)

    it('ledger:save-file 校验失败：tmp 删除、原文件不动、不重建索引', async () => {
      const read = (await handlers['ledger:read-file']()) as { content: string; fingerprint: string }
      const before = readFileSync(workFile, 'utf8')
      const bad = '2026-08-09 * "坏" "内容"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -9.00 CNY\n'
      const result = (await handlers['ledger:save-file']({}, {
        content: bad, expectedFingerprint: read.fingerprint
      })) as { ok: boolean; message?: string }
      expect(result.ok).toBe(false)
      expect(result.conflict).toBeUndefined()
      expect(result.message).toBeTruthy() // beancount 引擎错误文案（英文，勿断言具体词）
      expect(readFileSync(workFile, 'utf8')).toBe(before) // 原文件字节不变
      expect(existsSync(`${workFile}.m5tmp`)).toBe(false) // tmp 已清理
    }, 30_000)

    it('ledger:save-file 非法入参拒绝', async () => {
      await expect(handlers['ledger:save-file']({}, { content: 123, expectedFingerprint: 'x' })).rejects.toThrow()
      await expect(handlers['ledger:save-file']({}, { content: 'ok', expectedFingerprint: 'not-hex' })).rejects.toThrow()
    })

    it('ledger:read-file ENOENT → ok:false', async () => {
      const missing: Record<string, (...args: unknown[]) => unknown> = {}
      const ipc: IpcRegistrar = { handle: (c, l) => { missing[c] = l as (...args: unknown[]) => unknown } }
      registerLedgerHandlers(ipc, {
        db, engine, ledgerPath: join(tmpdir(), 'beanwise-m5-no-such', 'ledger.beancount')
      })
      const r = (await missing['ledger:read-file']()) as { ok: boolean; message: string }
      expect(r.ok).toBe(false)
      expect(r.message).toContain('账本文件不存在')
    }, 30_000)
  })
  ```

- [ ] **Step 6: 验证**
  `npm run typecheck` 绿；`npm run test:unit` 绿（含新增 editor 测试，真实引擎 30s 超时）。

- [ ] **Step 7: Commit**
  ```bash
  git add src/shared/ipc.ts src/shared/api.ts src/preload/index.ts src/main/index-builder.ts src/main/ipc-handlers.ts src/main/ipc-handlers-editor.test.ts
  git commit -m "feat: IPC 契约扩展——ledger:read-file / save-file（tmp+rename 落盘、冲突检测）（M5-T2）"
  ```

---

### Task 3: beancount 语法高亮（monarch 语言定义）

**Files:**
- Add: `src/renderer/src/monaco/beancount-language.ts`
- Add: `src/renderer/src/monaco/beancount-language.test.ts`

**Interfaces:**
- Consumes: monaco-editor（type-only import，注入式注册便于单测）
- Produces: `BEANCOUNT_LANGUAGE_ID = 'beancount'`、`BEANCOUNT_TOKENIZER`（纯数据）、`registerBeancountLanguage(monaco)`（幂等注册 language + monarch provider + 'beanwise' 主题）；Task 4 EditorView 使用

- [ ] **Step 1: 写语言定义（红 → 绿）**
  ```ts
  import type * as Monaco from 'monaco-editor'

  export const BEANCOUNT_LANGUAGE_ID = 'beancount'

  /**
   * beancount monarch 词法规则（M5 定稿）。规则顺序敏感：账户（含冒号）先于货币（无冒号）。
   * 导出为纯数据，便于单测断言 token 覆盖与顺序。
   */
  export const BEANCOUNT_TOKENIZER: Monaco.languages.IMonarchLanguage = {
    tokenizer: {
      root: [
        [/\s+/, 'white'],
        [/;.*$/, 'comment'],
        [/^(?:option|plugin|include|pushtag|poptag|note|balance|open|close|event|query|custom|commodity|price)\b/, 'keyword'],
        [/\d{4}-\d{2}-\d{2}/, 'number.date'],
        [/[*!#%&]/, 'type.flag'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/#[A-Za-z0-9\-_/.]+/, 'tag'],
        [/\^[A-Za-z0-9\-_/.]+/, 'link'],
        [/\b[A-Z][A-Za-z0-9-]*(?::[A-Z][A-Za-z0-9-]*)+/, 'type.account'],
        [/-?\d+(?:\.\d+)?/, 'number'],
        [/\b[A-Z][A-Z0-9']{1,8}\b/, 'currency']
      ]
    }
  }

  /** M5：注册 beancount 语言（幂等；monaco 注入便于单测传 mock 对象） */
  export function registerBeancountLanguage(monaco: typeof Monaco): void {
    if (monaco.languages.getLanguages().some((l) => l.id === BEANCOUNT_LANGUAGE_ID)) return
    monaco.languages.register({ id: BEANCOUNT_LANGUAGE_ID })
    monaco.languages.setMonarchTokensProvider(BEANCOUNT_LANGUAGE_ID, BEANCOUNT_TOKENIZER)
    monaco.editor.defineTheme('beanwise', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a737d' },
        { token: 'keyword', foreground: 'd73a49' },
        { token: 'string', foreground: '032f62' },
        { token: 'number.date', foreground: '005cc5' },
        { token: 'number', foreground: '005cc5' },
        { token: 'type.account', foreground: 'e36209' },
        { token: 'currency', foreground: '6f42c1' },
        { token: 'type.flag', foreground: 'd73a49' },
        { token: 'tag', foreground: '22863a' },
        { token: 'link', foreground: '22863a' }
      ]
    })
  }
  ```
  （若 `Monaco.languages.IMonarchLanguage` 类型不可用，改为 `Record<string, unknown>` + 局部断言。）

- [ ] **Step 2: 单测（新增 beancount-language.test.ts）**
  ```ts
  import { describe, expect, it, vi } from 'vitest'
  import {
    BEANCOUNT_LANGUAGE_ID,
    BEANCOUNT_TOKENIZER,
    registerBeancountLanguage
  } from './beancount-language'

  /** 注入式注册：运行时不需要真实 monaco，无需 vi.mock */
  function fakeMonaco() {
    return {
      languages: {
        getLanguages: vi.fn(() => []),
        register: vi.fn(),
        setMonarchTokensProvider: vi.fn()
      },
      editor: { defineTheme: vi.fn() }
    } as never
  }

  describe('beancount 语言注册（M5）', () => {
    it('注册 language + monarch provider + beanwise 主题', () => {
      const monaco = fakeMonaco() as {
        languages: { getLanguages: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn>; setMonarchTokensProvider: ReturnType<typeof vi.fn> }
        editor: { defineTheme: ReturnType<typeof vi.fn> }
      }
      registerBeancountLanguage(monaco as never)
      expect(monaco.languages.register).toHaveBeenCalledWith({ id: BEANCOUNT_LANGUAGE_ID })
      expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(BEANCOUNT_LANGUAGE_ID, BEANCOUNT_TOKENIZER)
      expect(monaco.editor.defineTheme).toHaveBeenCalledWith('beanwise', expect.objectContaining({ base: 'vs', inherit: true }))
    })

    it('幂等：已注册则跳过', () => {
      const monaco = fakeMonaco() as {
        languages: { getLanguages: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn>; setMonarchTokensProvider: ReturnType<typeof vi.fn> }
        editor: { defineTheme: ReturnType<typeof vi.fn> }
      }
      monaco.languages.getLanguages.mockReturnValue([{ id: BEANCOUNT_LANGUAGE_ID }])
      registerBeancountLanguage(monaco as never)
      expect(monaco.languages.register).not.toHaveBeenCalled()
    })

    it('tokenizer 覆盖关键 token，且账户先于货币（顺序敏感）', () => {
      const root = BEANCOUNT_TOKENIZER.tokenizer.root as Array<[RegExp, string]>
      const names = root.map(([, action]) => action)
      for (const t of ['comment', 'keyword', 'number.date', 'type.flag', 'string', 'type.account', 'number', 'currency', 'tag', 'link']) {
        expect(names).toContain(t)
      }
      expect(names.indexOf('type.account')).toBeLessThan(names.indexOf('currency'))
    })
  })
  ```

- [ ] **Step 3: 验证**
  `npm run typecheck` 绿；`npm run test:unit` 绿。

- [ ] **Step 4: Commit**
  ```bash
  git add src/renderer/src/monaco/beancount-language.ts src/renderer/src/monaco/beancount-language.test.ts
  git commit -m "feat: beancount monarch 语法高亮（账户/货币/指令/日期/金额/tag/link）（M5-T3）"
  ```

---

### Task 4: ledgerStore 扩展 + useEditorSave + EditorView + 应用壳导航

**Files:**
- Modify: `src/renderer/src/stores/ledger.ts`（编辑器状态 + actions，完整重写见 Step 1）
- Add: `src/renderer/src/stores/ledger-editor.test.ts`
- Add: `src/renderer/src/hooks/useEditorSave.ts`
- Add: `src/renderer/src/views/EditorView.tsx`
- Modify: `src/renderer/src/App.tsx`（「编辑器」导航项 + 三视图 display 保活）
- Modify: `src/renderer/src/styles.css`（编辑器布局样式）

**Interfaces:**
- Consumes: Task 2 `readLedgerFile` / `saveLedgerFile`（preload 白名单）；Task 3 `registerBeancountLanguage` / `BEANCOUNT_LANGUAGE_ID`；M4 `ledgerStore.refresh`（保存成功联动索引）
- Produces: 编辑器视图（端到端入口）+ 可单测的保存状态机（store actions）

- [ ] **Step 1: ledgerStore 扩展（完整重写 src/renderer/src/stores/ledger.ts）**
  ```ts
  /**
   * 渲染端账本数据唯一入口（zustand，M4）+ M5 编辑器状态。
   * 错误一律吞入 state 由 UI 展示（Alert / message），不向上抛——渲染进程不直连后端，
   * 全部经 preload 白名单 IPC。
   * 编辑器保存状态机（save/forceSave/conflict）落 store actions：node 环境可单测
   * （zustand 无需 DOM）；useEditorSave 仅做选择器 + 动作绑定。
   */
  import { message } from 'antd'
  import { create } from 'zustand'
  import type { LedgerEntryRow, LedgerStatus } from '../../../shared/ipc'

  export interface EditorConflict {
    diskContent: string
    diskFingerprint: string
  }

  interface LedgerState {
    status: LedgerStatus | null
    entries: LedgerEntryRow[]
    total: number
    accounts: string[]
    loading: boolean
    error: string | null
    refresh(): Promise<void>
    loadEntries(limit: number, offset: number): Promise<void>
    loadAccounts(): Promise<void>
    setError(error: string | null): void
    // ---- M5 编辑器 ----
    editorContent: string | null
    editorOriginal: string | null
    editorFingerprint: string | null
    editorLoaded: boolean
    editorMissing: boolean
    editorSaving: boolean
    editorConflict: EditorConflict | null
    loadEditorFile(): Promise<void>
    setEditorContent(content: string): void
    saveEditorFile(): Promise<void>
    forceSaveEditorFile(): Promise<void>
    reloadEditorFile(): Promise<void>
    continueEdit(): void
  }

  export const useLedgerStore = create<LedgerState>((set, get) => {
    /** M5 共享保存执行（save / forceSave 复用；conflict 时以 diskFingerprint 重试覆盖） */
    async function doSaveFile(content: string, expectedFingerprint: string): Promise<void> {
      try {
        const r = await window.beanwise.saveLedgerFile({ content, expectedFingerprint })
        if (r.conflict && r.diskContent !== undefined && r.diskFingerprint !== undefined) {
          set({ editorConflict: { diskContent: r.diskContent, diskFingerprint: r.diskFingerprint } })
          return
        }
        if (!r.ok) {
          message.error(`保存失败：${r.message ?? '校验未通过'}`)
          return
        }
        set((s) => ({ editorOriginal: s.editorContent, editorFingerprint: r.fingerprint ?? s.editorFingerprint }))
        message.success('已保存并校验通过')
        void get().refresh() // 索引联动：Header Tag / 明细视图
      } catch (err) {
        message.error(`保存失败：${String(err)}`)
      } finally {
        set({ editorSaving: false })
      }
    }

    return {
      status: null,
      entries: [],
      total: 0,
      accounts: [],
      loading: false,
      error: null,

      refresh: async () => {
        set({ loading: true, error: null })
        try {
          const [s, r] = await Promise.all([
            window.beanwise.getLedgerStatus(),
            window.beanwise.listLedgerEntries({ limit: 100 })
          ])
          set({ status: s, entries: r.entries, total: r.total })
        } catch (err) {
          set({ error: String(err) })
        } finally {
          set({ loading: false })
        }
      },

      loadEntries: async (limit, offset) => {
        set({ loading: true, error: null })
        try {
          const r = await window.beanwise.listLedgerEntries({ limit, offset })
          set({ entries: r.entries, total: r.total })
        } catch (err) {
          set({ error: String(err) })
        } finally {
          set({ loading: false })
        }
      },

      loadAccounts: async () => {
        try {
          const r = await window.beanwise.listLedgerAccounts()
          set({ accounts: r.accounts })
        } catch (err) {
          set({ error: String(err) })
        }
      },

      setError: (error) => set({ error }),

      // ---- M5 编辑器 ----
      editorContent: null,
      editorOriginal: null,
      editorFingerprint: null,
      editorLoaded: false,
      editorMissing: false,
      editorSaving: false,
      editorConflict: null,

      loadEditorFile: async () => {
        set({ editorLoaded: false, editorMissing: false })
        try {
          const r = await window.beanwise.readLedgerFile()
          if (!r.ok || r.content === undefined) {
            set({
              editorLoaded: true, editorMissing: true,
              editorContent: null, editorOriginal: null, editorFingerprint: null
            })
            return
          }
          set({
            editorLoaded: true, editorMissing: false,
            editorContent: r.content, editorOriginal: r.content,
            editorFingerprint: r.fingerprint ?? null
          })
        } catch (err) {
          set({
            editorLoaded: true, editorMissing: true,
            editorContent: null, editorOriginal: null, editorFingerprint: null,
            error: String(err)
          })
        }
      },

      setEditorContent: (content) => set({ editorContent: content }),

      saveEditorFile: async () => {
        const s = get()
        if (s.editorContent === null || s.editorFingerprint === null) return
        if (s.editorContent === s.editorOriginal) {
          message.info('无更改')
          return
        }
        set({ editorSaving: true, editorConflict: null })
        await doSaveFile(s.editorContent, s.editorFingerprint)
      },

      forceSaveEditorFile: async () => {
        const s = get()
        if (s.editorContent === null || !s.editorConflict) return
        set({ editorSaving: true })
        await doSaveFile(s.editorContent, s.editorConflict.diskFingerprint)
      },

      reloadEditorFile: async () => {
        set({ editorConflict: null })
        await get().loadEditorFile()
      },

      continueEdit: () => set({ editorConflict: null })
    }
  })
  ```

- [ ] **Step 2: store 单测（新增 src/renderer/src/stores/ledger-editor.test.ts）**
  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest'

  const message = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
  vi.mock('antd', () => ({ message }))

  import { useLedgerStore } from './ledger'

  type StubApi = {
    readLedgerFile: ReturnType<typeof vi.fn>
    saveLedgerFile: ReturnType<typeof vi.fn>
    getLedgerStatus: ReturnType<typeof vi.fn>
    listLedgerEntries: ReturnType<typeof vi.fn>
    listLedgerAccounts: ReturnType<typeof vi.fn>
    refreshLedgerIndex: ReturnType<typeof vi.fn>
  }

  function stubBeanwise(overrides: Partial<StubApi> = {}): StubApi {
    const api: StubApi = {
      readLedgerFile: vi.fn(),
      saveLedgerFile: vi.fn(),
      getLedgerStatus: vi.fn().mockResolvedValue(null),
      listLedgerEntries: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
      listLedgerAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
      refreshLedgerIndex: vi.fn().mockResolvedValue({ changed: false, status: 'ok', entryCount: 0, errorCount: 0 }),
      ...overrides
    }
    vi.stubGlobal('window', { beanwise: api })
    return api
  }

  const F = 'f'.repeat(64)

  beforeEach(() => {
    vi.unstubAllGlobals()
    useLedgerStore.setState({
      status: null, entries: [], total: 0, accounts: [], loading: false, error: null,
      editorContent: null, editorOriginal: null, editorFingerprint: null,
      editorLoaded: false, editorMissing: false, editorSaving: false, editorConflict: null
    })
    message.success.mockClear()
    message.error.mockClear()
    message.info.mockClear()
  })

  it('loadEditorFile：成功 → 内容 + 基线 + 指纹', async () => {
    stubBeanwise({ readLedgerFile: vi.fn().mockResolvedValue({ ok: true, content: '2026-01-01 open Assets:X', fingerprint: F }) })
    await useLedgerStore.getState().loadEditorFile()
    const s = useLedgerStore.getState()
    expect(s.editorLoaded).toBe(true)
    expect(s.editorMissing).toBe(false)
    expect(s.editorContent).toBe('2026-01-01 open Assets:X')
    expect(s.editorOriginal).toBe(s.editorContent)
    expect(s.editorFingerprint).toBe(F)
  })

  it('loadEditorFile：文件不存在 → missing 空态', async () => {
    stubBeanwise({ readLedgerFile: vi.fn().mockResolvedValue({ ok: false, message: '账本文件不存在' }) })
    await useLedgerStore.getState().loadEditorFile()
    const s = useLedgerStore.getState()
    expect(s.editorMissing).toBe(true)
    expect(s.editorContent).toBeNull()
  })

  it('saveEditorFile：无更改 → info 提示，不发 IPC', async () => {
    const api = stubBeanwise()
    useLedgerStore.setState({ editorContent: 'x', editorOriginal: 'x', editorFingerprint: F })
    await useLedgerStore.getState().saveEditorFile()
    expect(api.saveLedgerFile).not.toHaveBeenCalled()
    expect(message.info).toHaveBeenCalledWith('无更改')
  })

  it('saveEditorFile：成功 → 基线更新 + 成功提示 + refresh 联动', async () => {
    const api = stubBeanwise({
      saveLedgerFile: vi.fn().mockResolvedValue({ ok: true, fingerprint: 'b'.repeat(64), status: 'ok', entryCount: 6, errorCount: 0 })
    })
    useLedgerStore.setState({ editorContent: 'new', editorOriginal: 'old', editorFingerprint: F })
    await useLedgerStore.getState().saveEditorFile()
    expect(api.saveLedgerFile).toHaveBeenCalledWith({ content: 'new', expectedFingerprint: F })
    const s = useLedgerStore.getState()
    expect(s.editorOriginal).toBe('new')
    expect(s.editorFingerprint).toBe('b'.repeat(64))
    expect(s.editorSaving).toBe(false)
    expect(message.success).toHaveBeenCalledWith('已保存并校验通过')
    expect(api.getLedgerStatus).toHaveBeenCalled() // refresh 联动
  })

  it('saveEditorFile：冲突 → editorConflict 落 store，不发成功提示', async () => {
    stubBeanwise({
      saveLedgerFile: vi.fn().mockResolvedValue({ ok: false, conflict: true, diskContent: 'disk', diskFingerprint: 'c'.repeat(64) })
    })
    useLedgerStore.setState({ editorContent: 'local', editorOriginal: 'old', editorFingerprint: F })
    await useLedgerStore.getState().saveEditorFile()
    expect(useLedgerStore.getState().editorConflict).toEqual({ diskContent: 'disk', diskFingerprint: 'c'.repeat(64) })
    expect(message.success).not.toHaveBeenCalled()
  })

  it('saveEditorFile：校验失败 → 错误提示，基线不动', async () => {
    stubBeanwise({ saveLedgerFile: vi.fn().mockResolvedValue({ ok: false, message: 'Transaction does not balance' }) })
    useLedgerStore.setState({ editorContent: 'bad', editorOriginal: 'old', editorFingerprint: F })
    await useLedgerStore.getState().saveEditorFile()
    expect(message.error).toHaveBeenCalledWith('保存失败：Transaction does not balance')
    expect(useLedgerStore.getState().editorOriginal).toBe('old')
  })

  it('forceSaveEditorFile：以 diskFingerprint 重试覆盖 → 冲突清除', async () => {
    const api = stubBeanwise({
      saveLedgerFile: vi.fn().mockResolvedValue({ ok: true, fingerprint: 'b'.repeat(64), status: 'ok', entryCount: 6, errorCount: 0 })
    })
    useLedgerStore.setState({
      editorContent: 'local', editorOriginal: 'old', editorFingerprint: F,
      editorConflict: { diskContent: 'disk', diskFingerprint: 'c'.repeat(64) }
    })
    await useLedgerStore.getState().forceSaveEditorFile()
    expect(api.saveLedgerFile).toHaveBeenCalledWith({ content: 'local', expectedFingerprint: 'c'.repeat(64) })
    expect(useLedgerStore.getState().editorConflict).toBeNull()
  })

  it('reloadEditorFile：清冲突 + 重读文件', async () => {
    stubBeanwise({ readLedgerFile: vi.fn().mockResolvedValue({ ok: true, content: 'disk-now', fingerprint: F }) })
    useLedgerStore.setState({ editorConflict: { diskContent: 'disk', diskFingerprint: 'c'.repeat(64) } })
    await useLedgerStore.getState().reloadEditorFile()
    expect(useLedgerStore.getState().editorConflict).toBeNull()
    expect(useLedgerStore.getState().editorContent).toBe('disk-now')
  })
  ```

- [ ] **Step 3: useEditorSave hook（新增 src/renderer/src/hooks/useEditorSave.ts）**
  ```ts
  import { useCallback } from 'react'
  import { useLedgerStore } from '../stores/ledger'

  /**
   * M5：编辑器保存流程 UI 入口。状态机逻辑在 ledgerStore actions
   * （save/forceSave/reload 可 node 单测），本 hook 仅做选择器 + 动作绑定。
   */
  export function useEditorSave() {
    const content = useLedgerStore((s) => s.editorContent)
    const original = useLedgerStore((s) => s.editorOriginal)
    const saving = useLedgerStore((s) => s.editorSaving)
    const conflict = useLedgerStore((s) => s.editorConflict)
    const dirty = content !== null && content !== original

    const save = useCallback(() => { void useLedgerStore.getState().saveEditorFile() }, [])
    const forceSave = useCallback(() => { void useLedgerStore.getState().forceSaveEditorFile() }, [])
    const reload = useCallback(() => { void useLedgerStore.getState().reloadEditorFile() }, [])
    const continueEditing = useCallback(() => { useLedgerStore.getState().continueEdit() }, [])

    return { dirty, saving, conflict, save, forceSave, reload, continueEditing }
  }
  ```

- [ ] **Step 4: EditorView（新增 src/renderer/src/views/EditorView.tsx）**
  ```tsx
  import { ReloadOutlined, SaveOutlined } from '@ant-design/icons'
  import { Alert, Button, Empty, Space, Tag } from 'antd'
  import * as monaco from 'monaco-editor'
  import { useEffect, useRef } from 'react'
  import { useEditorSave } from '../hooks/useEditorSave'
  import { BEANCOUNT_LANGUAGE_ID, registerBeancountLanguage } from '../monaco/beancount-language'
  import { useLedgerStore } from '../stores/ledger'

  registerBeancountLanguage(monaco) // 模块级注册一次（幂等）

  /**
   * M5：账本编辑器视图。打开 → beancount 高亮 → 编辑 → 保存（tmp 校验 + rename 原子替换）
   * → 校验提示；保存时外部修改冲突 → DiffEditor（磁盘 vs 本地）三动作决策。
   * 视图由 App.tsx 保活（display 切换），组件常驻不销毁。
   */
  export default function EditorView() {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const diffRef = useRef<HTMLDivElement | null>(null)
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
    const loaded = useLedgerStore((s) => s.editorLoaded)
    const missing = useLedgerStore((s) => s.editorMissing)
    const content = useLedgerStore((s) => s.editorContent)
    const { dirty, saving, conflict, save, forceSave, reload, continueEditing } = useEditorSave()

    // 保存动作经 ref 引用：create effect 依赖保持空数组（避免 dirty 变化重建编辑器）
    const saveRef = useRef(save)
    useEffect(() => { saveRef.current = save })

    useEffect(() => { void useLedgerStore.getState().loadEditorFile() }, [])

    // 创建主编辑器（一次）
    useEffect(() => {
      const container = containerRef.current
      if (!container) return
      const editor = monaco.editor.create(container, {
        language: BEANCOUNT_LANGUAGE_ID,
        theme: 'beanwise',
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false
      })
      editorRef.current = editor
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current() })
      const sub = editor.onDidChangeModelContent(() => {
        useLedgerStore.getState().setEditorContent(editor.getValue())
      })
      return () => { sub.dispose(); editor.dispose(); editorRef.current = null }
    }, [])

    // 外部装载/重载：基线或内容变化后推送（值相同跳过，避免与 onDidChange 死循环）
    useEffect(() => {
      const editor = editorRef.current
      if (!editor || content === null) return
      if (editor.getValue() === content) return
      editor.setValue(content)
    }, [content])

    // 冲突面板 DiffEditor（monaco 直用双 model 组合，为 M6 三路合并铺路）
    useEffect(() => {
      if (!conflict || !diffRef.current) return
      const originalModel = monaco.editor.createModel(conflict.diskContent, BEANCOUNT_LANGUAGE_ID)
      const modifiedModel = monaco.editor.createModel(content ?? '', BEANCOUNT_LANGUAGE_ID)
      const diff = monaco.editor.createDiffEditor(diffRef.current, {
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        fontSize: 13
      })
      diff.setModel({ original: originalModel, modified: modifiedModel })
      return () => { diff.dispose(); originalModel.dispose(); modifiedModel.dispose() }
    }, [conflict, content])

    return (
      <div className="editor-view">
        <div className="editor-toolbar">
          <Space>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => save()}>
              保存
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => reload()}>重载</Button>
            <Tag color={dirty ? 'warning' : 'success'}>{dirty ? '未保存' : '已保存'}</Tag>
          </Space>
        </div>
        {conflict ? (
          <div className="editor-conflict">
            <Alert
              type="warning"
              showIcon
              message="文件已被外部修改（录入视图追加或外部编辑器）"
              description="左侧为磁盘最新内容，右侧为当前编辑内容。选择：重新加载（放弃本地修改）或强制保存（覆盖外部修改）。"
              action={
                <Space>
                  <Button size="small" onClick={continueEditing}>继续编辑</Button>
                  <Button size="small" onClick={() => reload()}>重新加载</Button>
                  <Button size="small" type="primary" danger loading={saving} onClick={() => forceSave()}>
                    强制保存
                  </Button>
                </Space>
              }
            />
            <div ref={diffRef} className="editor-diff" />
          </div>
        ) : null}
        <div ref={containerRef} className="editor-main" />
        {loaded && missing ? (
          <div className="editor-empty">
            <Empty description="账本文件不存在，请先在录入视图录一笔创建" />
          </div>
        ) : null}
      </div>
    )
  }
  ```

- [ ] **Step 5: 应用壳导航（App.tsx）**
  - import 加 `FileTextOutlined`、`EditorView`；view 类型扩为 `useState<'entry' | 'entries' | 'editor'>('entry')`
  - Menu items 追加：`{ key: 'editor', icon: <FileTextOutlined />, label: '编辑器' }`
  - Content 区改为三视图保活（display 切换，编辑器状态不丢）：
    ```tsx
    <Content style={{ padding: 24 }}>
      <div style={{ display: view === 'entry' ? 'block' : 'none' }}><EntryFormView /></div>
      <div style={{ display: view === 'entries' ? 'block' : 'none' }}><EntriesView /></div>
      <div style={{ display: view === 'editor' ? 'block' : 'none', height: 'calc(100vh - 112px)' }}>
        <EditorView />
      </div>
    </Content>
    ```

- [ ] **Step 6: 样式（styles.css 追加）**
  ```css
  .editor-view { display: flex; flex-direction: column; height: 100%; }
  .editor-toolbar { padding-bottom: 8px; }
  .editor-main { flex: 1; min-height: 0; border: 1px solid #f0f0f0; }
  .editor-conflict { margin-bottom: 8px; }
  .editor-diff { height: 320px; border: 1px solid #f0f0f0; }
  .editor-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  ```

- [ ] **Step 7: 验证**
  `npm run typecheck` 绿；`npm run test:unit` 绿（新增 store 测试）；`npm run dev` 手工冒烟：切「编辑器」→ 内容加载 + 高亮可见 → 改动 → Ctrl+S 保存 → 成功提示 → Header Tag 索引联动；录入视图加一笔后编辑器保存 → 冲突面板出现。

- [ ] **Step 8: Commit**
  ```bash
  git add src/renderer/src/stores/ledger.ts src/renderer/src/stores/ledger-editor.test.ts src/renderer/src/hooks/useEditorSave.ts src/renderer/src/views/EditorView.tsx src/renderer/src/App.tsx src/renderer/src/styles.css
  git commit -m "feat: 编辑器视图——Monaco + beancount 高亮 + 保存状态机 + 冲突 DiffEditor 面板（M5-T4）"
  ```

---

### Task 5: E2E（绿灯 / 冲突 / 失败三条链路）

**Files:**
- Add: `e2e/editor.spec.ts`
- Modify: `e2e/smoke.spec.ts`（若引用了旧导航断言需同步——检查后定，通常 smoke 只断启动）

**Interfaces:**
- Consumes: Playwright electron.launch（`BEANWISE_LEDGER_PATH` 指向 fixture 副本）；M4 `createFixtureCopy` / `cleanupFixture`（`e2e/fixtures/setup.ts` 复用）；M5 编辑器 UI（role/text 定位）
- Produces: M5 绿灯验收自动化

- [ ] **Step 1: 绿灯链路（新增 e2e/editor.spec.ts）**
  ```ts
  import { _electron as electron, expect, test } from '@playwright/test'
  import { readFileSync } from 'node:fs'
  import { cleanupFixture, createFixtureCopy } from './fixtures/setup'

  const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

  test('M5 绿灯：打开账本 → beancount 高亮 → 编辑保存 → 校验提示 → 索引联动', async () => {
    const ledgerPath = createFixtureCopy()
    try {
      const app = await electron.launch({
        args: launchArgs,
        env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
      })
      const win = await app.firstWindow()
      await win.getByRole('menuitem', { name: '编辑器' }).click()

      // 1. 内容加载 + 高亮（tokenized span：class 形如 mtk1，用属性包含匹配）
      const editor = win.locator('.editor-main .monaco-editor')
      await expect(editor).toBeVisible()
      await expect(win.locator('.editor-main .view-lines')).toContainText('Breakfast')
      const tokenSpans = await win.locator('.editor-main .view-line [class*="mtk"]').count()
      expect(tokenSpans).toBeGreaterThan(0)

      // 2. 编辑：跳到文件尾追加一笔合法交易（fixture 已 open Expenses:Food / Assets:Bank:CNB）
      await win.locator('.editor-main .monaco-editor').click()
      await win.keyboard.press('Control+End')
      await win.keyboard.type('\n2026-08-09 * "M5 E2E" "编辑器保存"\n  Expenses:Food  8.00 CNY\n  Assets:Bank:CNB  -8.00 CNY')

      // 3. 保存 → 成功提示 + 文件断言 + 明细联动
      const before = readFileSync(ledgerPath, 'utf8')
      await win.getByRole('button', { name: '保存' }).click()
      await expect(win.locator('.ant-message')).toContainText('已保存并校验通过')
      const after = readFileSync(ledgerPath, 'utf8')
      expect(after).toContain('"M5 E2E"')
      expect(after.length).toBeGreaterThan(before.length)

      await win.getByRole('menuitem', { name: '明细' }).click()
      await expect(win.locator('.ant-table-tbody')).toContainText('M5 E2E')

      await app.close()
    } finally {
      cleanupFixture(ledgerPath)
    }
  })
  ```

- [ ] **Step 2: 冲突链路（同文件追加）**
  ```ts
  test('M5 冲突：外部修改 → 保存触发冲突面板 → 重新加载回滚到磁盘内容', async () => {
    const ledgerPath = createFixtureCopy()
    try {
      const app = await electron.launch({
        args: launchArgs,
        env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
      })
      const win = await app.firstWindow()

      // 1. 编辑器先加载文件（基线指纹 F1）
      await win.getByRole('menuitem', { name: '编辑器' }).click()
      await expect(win.locator('.editor-main .view-lines')).toContainText('Breakfast')

      // 2. 外部修改：录入视图加一笔（文件 → F2，编辑器基线仍为 F1）
      await win.getByRole('menuitem', { name: '录入' }).click()
      await win.getByLabel('Payee').fill('外部修改')
      await win.getByLabel('账户').nth(0).fill('Expenses:Food')
      await win.getByLabel('金额').nth(0).fill('25.50')
      await win.getByLabel('货币').nth(0).fill('CNY')
      await win.getByLabel('账户').nth(1).fill('Assets:Bank:CNB')
      await win.getByLabel('货币').nth(1).fill('CNY')
      await win.getByRole('button', { name: '写入账本' }).click()
      await expect(win.locator('.ant-message')).toContainText('已写入并校验通过')

      // 3. 回编辑器改动并保存 → 冲突面板（DiffEditor 可见）
      await win.getByRole('menuitem', { name: '编辑器' }).click()
      await win.locator('.editor-main .monaco-editor').click()
      await win.keyboard.press('Control+End')
      await win.keyboard.type(' ')
      await win.getByRole('button', { name: '保存' }).click()
      await expect(win.locator('.monaco-diff-editor').first()).toBeVisible()

      // 4. 重新加载 → 冲突面板消失，编辑器内容 = 磁盘内容（含「外部修改」）
      await win.getByRole('button', { name: '重新加载' }).click()
      await expect(win.locator('.monaco-diff-editor')).toHaveCount(0)
      await expect(win.locator('.editor-main .view-lines')).toContainText('外部修改')

      await app.close()
    } finally {
      cleanupFixture(ledgerPath)
    }
  })
  ```

- [ ] **Step 3: 失败链路（同文件追加）**
  ```ts
  test('M5 失败：保存校验失败 → 错误提示 + 文件字节不变', async () => {
    const ledgerPath = createFixtureCopy()
    try {
      const app = await electron.launch({
        args: launchArgs,
        env: { ...process.env, BEANWISE_LEDGER_PATH: ledgerPath }
      })
      const win = await app.firstWindow()
      await win.getByRole('menuitem', { name: '编辑器' }).click()
      await expect(win.locator('.editor-main .view-lines')).toContainText('Breakfast')

      const before = readFileSync(ledgerPath, 'utf8')
      // 追加借贷不平的交易（10 vs -9）→ parse 失败，tmp 删除、原文件不动
      await win.locator('.editor-main .monaco-editor').click()
      await win.keyboard.press('Control+End')
      await win.keyboard.type('\n2026-08-09 * "不平衡" "保存失败"\n  Expenses:Food  10.00 CNY\n  Assets:Bank:CNB  -9.00 CNY')
      await win.getByRole('button', { name: '保存' }).click()
      await expect(win.locator('.ant-message')).toContainText('保存失败')
      expect(readFileSync(ledgerPath, 'utf8')).toBe(before)

      await app.close()
    } finally {
      cleanupFixture(ledgerPath)
    }
  })
  ```

- [ ] **Step 4: smoke.spec.ts 检查**
  读 `e2e/smoke.spec.ts`：若其断言依赖 M4 前视图结构（如「录入」按钮可见），一般无需改动；若有对 Content 区唯一子元素的假设，同步为「录入 / 明细 / 编辑器」三视图语义。

- [ ] **Step 5: 验证**
  `npm run test:e2e`（本机需 `env -u ELECTRON_RUN_AS_NODE`）绿；CI ubuntu 头下同样绿（xvfb 已有）。

- [ ] **Step 6: Commit**
  ```bash
  git add e2e/editor.spec.ts e2e/smoke.spec.ts
  git commit -m "test: E2E M5 绿灯 + 冲突 + 失败链路（M5-T5）"
  ```

---

### Task 6: 文档同步 + M5 绿灯验收

**Files:**
- Modify: `technical-proposal/implementation-roadmap.md`（「IPC 契约」表补两通道；M5 边界行补定稿语义）
- Modify: `CLAUDE.md`（技术栈补 Monaco 集成结论；约束 #8 补 worker-src；「常见坑」补 Monaco worker 打包）
- Modify: `technical-proposal/tech-stack.md`（Monaco 行补落地结论）
- Modify: `technical-proposal/security.md`（CSP 段补 worker-src）
- Modify: `technical-proposal/design-decisions.md`（ADR 8 补实现结论）

**Interfaces:**
- Consumes: Task 1-5 定稿的全部契约
- Produces: 文档与代码一致（roadmap 是全项目锚点）

- [ ] **Step 1: roadmap 同步**
  「IPC 契约」表追加：
  | `ledger:read-file` | 无 | `{ok, content?, fingerprint?, message?}` |
  | `ledger:save-file` | `{content, expectedFingerprint}` | `{ok, conflict?, diskContent?, diskFingerprint?, fingerprint?, status?, entryCount?, errorCount?, message?}` |
  M5 边界行补注：整文件覆盖「tmp 校验 + rename 原子替换」（校验失败不落盘）、外部修改冲突检测（sha256 指纹比对 + DiffEditor 决策）、monarch 自研高亮、生产 CSP `worker-src 'self'`。

- [ ] **Step 2: CLAUDE.md / 方案文档同步**
  - 技术栈补：Monaco Editor（裸 `monaco-editor` + Vite `?worker` + 自研 monarch beancount 语言，M5 定稿）
  - 约束 #8 措辞：生产 `default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`（worker-src 因 Monaco worker 独立 chunk）
  - 常见坑补：Monaco worker 必须本地打包（`?worker` + `MonacoEnvironment`），禁 CDN loader；生产 CSP 需 `worker-src 'self'`
  - tech-stack.md / security.md / design-decisions.md（ADR 8 落地结论）同步

- [ ] **Step 3: 绿灯验收（对照 roadmap M5 行）**
  - `npm run typecheck` 绿
  - `npm run test:unit` 全绿（含 M5 新增 main handler / store / 语言注册测试）
  - `npm run test:e2e` 绿（绿灯 + 冲突 + 失败链路）
  - 手工双确认：`npm run dev` 打开账本 → 高亮 → 编辑 → 保存 → 校验提示；录入视图加一笔后编辑器保存 → 冲突 DiffEditor → 重新加载/强制保存
  - 全部通过后：roadmap 执行节奏进入下一里程碑（M6）

- [ ] **Step 4: Commit**
  ```bash
  git add technical-proposal/implementation-roadmap.md CLAUDE.md technical-proposal/tech-stack.md technical-proposal/security.md technical-proposal/design-decisions.md
  git commit -m "docs: M5 定稿同步——IPC 两通道 + 落盘/冲突策略 + CSP worker-src + Monaco 集成结论（M5-T6）"
  ```

---

## M5 绿灯验收汇总

| 验收项 | 方式 | 判定 |
|---|---|---|
| 打开账本 → 内容加载 | E2E Step 1 + 手工 | `.editor-main` 可见、含 fixture 内容 |
| beancount 高亮 | E2E Step 1 | `.view-line [class*="mtk"]` 计数 > 0 |
| 编辑保存 → 校验提示 | E2E Step 1 / Step 3 | 成功 message / 「保存失败」message |
| 文件落盘（tmp+rename） | E2E Step 1 文件断言 | 文件含新交易、长度增长、无 `.m5tmp` 残留 |
| 索引联动 | E2E Step 1.3 | 明细含新交易 |
| 外部修改冲突检测 | E2E Step 2 + 单测 | 冲突面板 DiffEditor 可见、未落盘；重新加载回滚 |
| 校验失败不落盘 | E2E Step 3 + 单测 | 错误提示、文件字节不变 |
| typecheck / 单测 / E2E | CI + 本机 | 全绿 |

## M6 交接说明（不在本计划内）

- **三路合并 UI**：M5 已落地 `monaco.editor.createDiffEditor` 双 model 组合（冲突面板），M6 冲突合并 = 三路（base/ours/theirs）双 DiffEditor 组合复用同一模式；`SaveFileResult` 的 conflict 快照结构可扩展为合并输入
- **保存后自动 git 同步**：M6 在 `saveEditorFile` 成功路径（store `doSaveFile` 的 `void get().refresh()` 旁）挂同步触发点
- **错误定位到行**：`parse_entries` errors 已含 `lineno`（python/engine/ledger.py:23），M5 后置可做 Monaco `setPosition` + markers，本里程碑按用户裁决不纳入
- **实时 lint / 自动保存 / 按日期重排 / 主题切换**：均见 spec §10，留后续评估
