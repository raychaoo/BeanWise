# M4 核心录入链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地核心录入链路：ProForm 录一笔 → 落文件（TS 主进程序列化 beancount 文本）→ 校验 → 索引更新（端到端）。绿灯验收：录入一笔交易 → 账本文件含该笔 → 索引可见，typecheck 绿。

**Architecture:** 渲染进程引入 antd 应用壳（Sider 导航「录入 / 明细」，为 M5-M8 预留扩展位），录入用 ProForm + Form.List 动态 postings + 自动平衡（末行金额实时补差）；主进程新增 `ledger:add-entry`（前置校验 → serializer 纯函数 → 追加写文件 → 复用 M3 `refreshIndex` 校验重建，索引 error 时 truncate 回滚）与 `ledger:list-accounts`（postings 表 DISTINCT，账户自动补全）。金额一律**十进制字符串**传递与运算（`src/shared/decimal.ts` 纯函数），渲染端 InputNumber `stringMode`、主进程字符串加法校验，杜绝浮点误差。M3 只读验收面板下线，由正式界面取代。

**Tech Stack:** antd 5.29 · @ant-design/pro-components 2.8.10 · @ant-design/v5-patch-for-react-19（React 19 静态方法补丁）· @ant-design/icons · zustand（渲染端轻量 store）· dayjs（antd 自带，补 zh-cn locale）· Node fs（append/truncate 回滚）

## Global Constraints

- **版本与平台**：Windows-only；Electron 43 · React 19.2 · Node 22（CI）· Python 3.11（本机 `py -3.11`，`BEANWISE_PYTHON_CMD` 可覆盖）；`npm run dev` 前 `env -u ELECTRON_RUN_AS_NODE`（VS Code 集成终端泄漏）
- **依赖矩阵（M4 定稿，Task 1 安装）**：
  - `antd@^5.29.3`（**不用 v6**：@ant-design/pro-components 2.8.10 peer 只支持 `^4 || ^5`；pro-components 3.x beta 支持 antd v6，但 beta 不进 M4——M8 图表期再评估迁移）
  - `@ant-design/pro-components@^2.8.10`、`@ant-design/icons@^6`、`@ant-design/v5-patch-for-react-19@^1.0.3`（antd v5 + React 19 必须，**main.tsx 最顶部导入，先于一切 antd import**）
  - `zustand@^5`（渲染端状态管理，CLAUDE.md「状态管理用 Zustand」）
- **CSP 修订（CLAUDE.md 约束 #8 同步，2026-08-09 裁决）**：生产 `style-src` 放宽为 `'self' 'unsafe-inline'`（antd v5 CSS-in-JS 运行时注入 `<style>`，静态提取成本过高），`script-src` 保持严格（禁 `unsafe-inline` / `unsafe-eval`）；开发模式不变。`csp.ts` 的 `CSP_PROD` 与 `csp.test.ts` 同步更新
- **新增 IPC 契约（Task 3 定稿并同步 roadmap「IPC 契约」表）**：
  - `ledger:add-entry`：params `{date: "YYYY-MM-DD", flag?: '*'|'!', payee?: str, narration?: str, postings: [{account, number: str, currency: str}]}`（2~20 行）→ result `{ok, message?, status, entryCount, errorCount}`（status 为索引重建后的 'ok'|'error'）
  - `ledger:list-accounts`：无参 → `{accounts: string[]}`（`SELECT DISTINCT account FROM postings ORDER BY account LIMIT 500`）
  - 类型唯一来源 `src/shared/ipc.ts` → preload 白名单 → main handler；账本路径主进程持有，渲染进程不传路径
  - **金额一律字符串**：`number` 为十进制字符串（正则 `^-?\d+(\.\d+)?$`），渲染端 InputNumber `stringMode` 直取字符串，主进程余额校验用 `addDecimalStrings`（精确十进制加法，禁 `parseFloat`）
- **Serializer 契约（M4 定稿，`src/main/entry-serializer.ts` 纯函数）**：
  - `serializeEntry(params) -> string`：输出以 `\n` 结尾的 beancount 文本块，**不含前导空行**：
    ```
    2026-08-09 * "Payee" "Narration"
      Expenses:Food  100.00 CNY
      Assets:Cash  -100.00 CNY
    ```
  - 规则：日期原样 `YYYY-MM-DD`；flag 默认 `*`；payee+narration 都有 → `"payee" "narration"`，只有 payee → `"payee"`（beancount 单字符串归 payee，与 M3 fixture 解析一致），只有 narration → `"" "narration"`；`"` 转义为 `\"`；**拒收** `\n`/`\r`/控制字符（`validateEntryParams` 拦，throw）；posting 行 = 两空格缩进 + `account` + 两空格 + `number` + 空格 + `currency`（金额原样字符串，不做对齐美化）
  - `validateEntryParams(raw: unknown) -> AddEntryParams`：类型与范围校验（date 正则 + 真实日期、flag 白名单、payee/narration 长度上限 200 且无控制字符、postings 2~20 行、account 非空无空白含冒号且首字符大写字母、number 金额正则、currency 非空无空白 ≤24 字符）；非法 → `throw Error(中文消息)`（invoke reject，UI 展示）
- **写入与回滚（M4 定稿，补 data-consistency.md 缺失的写失败策略）**：
  1. `validateEntryParams` + 余额校验（`addDecimalStrings(...) === '0'`，非 0 throw「借贷不平衡」）
  2. 文件不存在 → `mkdirSync(dir, {recursive:true})` + 直接创建（首文件场景；无 options 合法，operatingCurrency 空 → 货币下拉退化为 Input）
  3. 追加前：`preLength = statSync.size + (末字节 !== 0x0a ? 1 : 0)`；一次 `appendFile(path, (末字节非\n ? '\n' : '') + serializeEntry(params), 'utf8')`
  4. `refreshIndex(db, engine, path)`（M3 管线：parse_entries 校验 → 事务重建）
  5. status==='error'（前置校验已拦绝大部分，理论上不发生）→ `truncateSync(preLength)` 回滚 → 返回 `{ok:false, message, status, entryCount: 旧索引计数, errorCount}`；回滚失败 → 记日志，status 保持 error（留 M5 手工修复）
  6. 成功 → `{ok:true, status:'ok', entryCount, errorCount}`
- **渲染进程边界**：不直连 Python / SQLite / fs，一律走 IPC 白名单；preload 新增 `addLedgerEntry` / `listLedgerAccounts` 两方法
- **测试**：Vitest node 环境（Electron 模块不可 import；handler 注入式 mock；写文件用 `mkdtempSync` 临时目录 + 真实 fs + mock engine 断言 append/truncate）；serializer / decimal / 自动平衡纯函数单测覆盖边界；E2E 用 fixture 副本（`fs.copyFileSync` 到临时文件，`BEANWISE_LEDGER_PATH` 指向副本，断言文件内容与长度变化）
- **不做（M4 边界，roadmap「里程碑边界说明」）**：编辑已有交易（M5 Monaco）；tags/links/cost 字段（M5+）；AI 录入（M7）；fs.watch 自动监听（M5 保存链路主动触发）；账本骨架文件自动生成（M4 只在「录入首笔」时顺带创建，不生成 options 模板）
- **提交**：每个任务一个 commit，约定式前缀，中文消息（与 M1-M3 一致）；不附加任何 Co-Authored-By 署名
- **文档同步（Task 7）**：roadmap「IPC 契约」表补 `ledger:add-entry` / `ledger:list-accounts`；CLAUDE.md 技术栈补 antd 依赖矩阵（含 v5-patch）与 CSP 约束 #8 修订

---

### Task 1: 依赖引入 + CSP 修订 + React 19 补丁

**Files:**
- Modify: `package.json`（五件套依赖）
- Modify: `src/main/csp.ts`（CSP_PROD 放宽 style-src）
- Modify: `src/main/csp.test.ts`（断言同步）
- Modify: `src/renderer/src/main.tsx`（v5-patch 首行导入 + ConfigProvider zhCN + dayjs locale）
- （CLAUDE.md 文档同步统一归 Task 7）

**Interfaces:**
- Consumes: M3 定稿 CSP（`src/main/csp.ts` 注入式、`csp.test.ts` 断言）
- Produces: 渲染进程 antd 运行环境；生产 CSP `style-src 'self' 'unsafe-inline'`；React 19 兼容层

- [ ] **Step 1: 安装依赖**
  ```bash
  npm i antd@^5.29.3 @ant-design/pro-components@^2.8.10 @ant-design/icons@^6 @ant-design/v5-patch-for-react-19@^1.0.3 zustand@^5
  ```
  postinstall 钩子会跑（better-sqlite3 检查），确认无 fail-loud 报错。

- [ ] **Step 2: CSP 修订**
  `src/main/csp.ts`：
  ```ts
  export const CSP_PROD = "default-src 'self'; style-src 'self' 'unsafe-inline'"
  ```
  `csp.test.ts` 同步断言（读 `csp.ts` 导出的 CSP_PROD 断言含 `style-src 'self' 'unsafe-inline'` 且不含 `script-src`、不含 `unsafe-eval`）。

- [ ] **Step 3: React 19 补丁 + 中文环境**
  `src/renderer/src/main.tsx` **第一行**（先于所有 antd import）：
  ```ts
  import '@ant-design/v5-patch-for-react-19'
  import 'dayjs/locale/zh-cn'
  ```
  App 外层包 `ConfigProvider locale={zhCN}`（`antd/locale/zh_CN`）；dayjs 设置中文（`dayjs.locale('zh-cn')`）。

- [ ] **Step 4: 验证**
  `npm run typecheck` 绿；`npm run test:unit` 绿（csp 断言更新后）。

---

### Task 2: 金额工具 + entry-serializer（纯函数 + 单测）

**Files:**
- Add: `src/shared/decimal.ts`（`addDecimalStrings` / `negateDecimal` / `isZeroDecimal` / `computeBalancingNumber`）
- Add: `src/shared/decimal.test.ts`
- Add: `src/main/entry-serializer.ts`（`validateEntryParams` / `serializeEntry`）
- Add: `src/main/entry-serializer.test.ts`

**Interfaces:**
- Consumes: Task 3 定稿的 `AddEntryParams` / `AddEntryPosting` 类型（**本 Task Step 0 先在 `src/shared/ipc.ts` 定义新类型**——类型是契约唯一来源，先于使用方）
- Produces: 序列化纯函数（主进程 add-entry 用）；十进制字符串运算（渲染端自动平衡 + 主进程余额校验共用）

- [ ] **Step 0: 类型先行（src/shared/ipc.ts）**
  ```ts
  export type IpcChannel = 'ledger:refresh-index' | 'ledger:status' | 'ledger:list-entries'
    | 'ledger:add-entry' | 'ledger:list-accounts'
  export interface AddEntryPosting { account: string; number: string; currency: string }
  export interface AddEntryParams { date: string; flag?: '*' | '!'; payee?: string; narration?: string; postings: AddEntryPosting[] }
  export interface AddEntryResult { ok: boolean; message?: string; status: LedgerIndexStatus; entryCount: number; errorCount: number }
  export interface ListAccountsResult { accounts: string[] }
  ```
  （`api.ts` / preload 白名单在 Task 3 接，本 Task 只定义类型）

- [ ] **Step 1: `src/shared/decimal.ts`（红 → 绿）**
  - `addDecimalStrings(a, b) -> string`：字符串十进制加法，支持负号，结果规范化（去前导零、`-0` → `0`、保留两侧最大小数位）；实现：拆符号/整数/小数部分逐位运算（约 40 行），**禁 parseFloat/Number**
  - `negateDecimal(s) -> string`：符号翻转
  - `isZeroDecimal(s) -> boolean`：`addDecimalStrings(s, '0') === '0'`
  - `computeBalancingNumber(amounts: string[]) -> string`：`negateDecimal(各数相加)`；和为 0 → 返回 `'0'`
  - 测试：正负混加、不同小数位（`0.1 + 0.2 === '0.3'` 浮点等价性）、借位进位、`-0.00` 规范化、空输入、非法输入 throw

- [ ] **Step 2: `src/main/entry-serializer.ts`（红 → 绿）**
  - `validateEntryParams(raw: unknown)`：按 Global Constraints「Serializer 契约」逐项校验，throw 中文 Error
  - `serializeEntry(params)`：按契约输出文本块；payee/narration 转义 `"` → `\"`、trim；posting 行拼接；末尾 `\n`
  - 测试：完整交易输出快照、无 payee/无 narration 分支、引号转义、换行拒绝、日期非法拒绝、account 非法拒绝、posting 数量边界（1 行拒绝 / 21 行拒绝）、金额格式拒绝

---

### Task 3: IPC 契约扩展 + 主进程 handler（add-entry / list-accounts）

**Files:**
- Modify: `src/shared/ipc.ts`（IpcChannel + 5 个新类型）
- Modify: `src/shared/api.ts`（BeanWiseApi 加 `addLedgerEntry` / `listLedgerAccounts`）
- Modify: `src/preload/index.ts`（白名单两方法）
- Modify: `src/main/ipc-handlers.ts`（`registerLedgerHandlers` 注册两通道 + 校验）
- Add: `src/main/ipc-handlers-entry.test.ts`（或并入 `ipc-handlers.test.ts`）
- Modify: `src/main/index.ts`（无需改——handler 已注入依赖）

**Interfaces:**
- Consumes: Task 2 serializer / decimal；M3 `refreshIndex` / `getLedgerStatus` 不动
- Produces: 两个新通道的完整 3 层链路；写文件 + 回滚逻辑（主进程）

- [ ] **Step 1: 白名单接线（api.ts + preload）**
  类型已在 Task 2 Step 0 定稿于 `src/shared/ipc.ts`；`api.ts` 的 `BeanWiseApi` 加 `addLedgerEntry(params: AddEntryParams): Promise<AddEntryResult>` 与 `listLedgerAccounts(): Promise<ListAccountsResult>`；`preload/index.ts` 同步两方法（`ipcRenderer.invoke('ledger:add-entry', params)` / `ipcRenderer.invoke('ledger:list-accounts')`）。

- [ ] **Step 2: 主进程 handler（红 → 绿）**
  `ipc-handlers.ts` 新增：
  - `ledger:add-entry`：
    1. `validateEntryParams(params)`（Task 2）→ 类型错误 throw
    2. 余额校验 `computeBalancingNumber(numbers)` 非 0 → throw「借贷不平衡：差额 X」
    3. 文件处理：不存在 → `mkdirSync(dirname, {recursive:true})`；`statSync` 取 size、末字节判断；`preLength` 计算；`appendFileSync(path, tail + serializeEntry(params), 'utf8')`
    4. `refreshIndex(db, engine, path)` → status==='error' → `truncateSync(preLength)` + 返回 `{ok:false, ...}`；成功 → `{ok:true, status, entryCount, errorCount}`
    5. 任何 fs 异常 → catch 转 throw（invoke reject）
  - `ledger:list-accounts`：`db.select({account: postings.account}).from(postings).groupBy(...)` 或 DISTINCT + orderBy + limit 500 → `{accounts}`
  - **注意**：handler 内 fs 用 `node:fs` 同步 API（与 M3 一致）；测试注入 temp dir + mock engine（`refreshIndex` 断言被调用、错误路径断言 truncate）

- [ ] **Step 3: 单测覆盖（temp dir）**
  - 正常链路：写入后文件末尾追加序列化文本；`refreshIndex` mock 返回 ok → result.ok
  - 首文件：目录不存在 → 自动创建 + 文件内容恰为 entry 块
  - 余额不平：throw「借贷不平衡」；文件未被创建/未改动（断言 preLength 不变）
  - 回滚：mock `refreshIndex` 返回 status='error' → 文件被 truncate 回原长度、result.ok=false
  - 文件尾无 `\n`：先补 `\n` 再追加（断言文件内容拼接正确）
  - list-accounts：mock db 返回 DISTINCT 结果

---

### Task 4: ledgerStore + 应用壳 + 明细视图（M3 验收面板下线）

**Files:**
- Add: `src/renderer/src/stores/ledger.ts`（zustand）
- Add: `src/renderer/src/views/EntriesView.tsx`（明细视图）
- Modify: `src/renderer/src/App.tsx`（重构为应用壳 + 路由切换）
- Modify: `src/renderer/src/styles.css`（布局样式）
- Delete（下线）: M3 验收面板的 `#ledger-status` / `#ledger-entries` 区块（App.tsx 内，随重构删除）

**Interfaces:**
- Consumes: preload 白名单（`getLedgerStatus` / `listLedgerEntries` / `refreshLedgerIndex` / `listLedgerAccounts`）
- Produces: 渲染端唯一数据入口 `ledgerStore`；明细视图（antd Table + 状态卡）；应用壳导航

- [ ] **Step 1: `stores/ledger.ts`（zustand）**
  ```ts
  interface LedgerState {
    status: LedgerStatus | null
    entries: LedgerEntryRow[]
    total: number
    loading: boolean
    error: string | null
    refresh(): Promise<void>          // 并行拉 status + entries(limit 默认)
    loadEntries(limit: number, offset: number): Promise<void>
  }
  ```
  错误吞入 state（UI 展示），不向上抛。

- [ ] **Step 2: 应用壳（App.tsx）**
  - `Layout`：Sider（`Menu` 两项：录入 / 明细，`selectedKeys` 本地 state 切换视图，不引 router——两视图无 URL 需求）+ Header（标题 + 索引状态 `Tag`：ok 绿 / error 红 / missing 灰，点击刷新）+ Content
  - 视图切换：`const [view, setView] = useState<'entry' | 'entries'>('entry')`，条件渲染两视图
  - 首次挂载 `store.refresh()`

- [ ] **Step 3: 明细视图（EntriesView.tsx）**
  - 状态卡：`Descriptions`（path / status / entryCount / errorCount / lastError / updatedAt）+ 刷新按钮（`refreshLedgerIndex` → store.refresh）
  - 条目表：antd `Table`（columns: date / flag / type / payee / narration / account；`pagination={{pageSize:20, total, current, onChange}}` 服务端分页走 `store.loadEntries`；rowKey=id；loading 态）
  - **下线 M3 验收面板**：App.tsx 中旧 `#ledger-status` / `#ledger-entries` 区块删除（E2E 依赖的 id 随 Task 6 重写）

- [ ] **Step 4: 验证**
  `npm run typecheck` + `npm run test:unit` 绿；`npm run dev` 手工确认壳与明细渲染（fixture 账本路径）。

---

### Task 5: 录入视图（ProForm + 动态 postings + 自动平衡）

**Files:**
- Add: `src/renderer/src/views/EntryFormView.tsx`
- Add: `src/renderer/src/views/entry-form.test.ts`（自动平衡纯逻辑单测——若抽为独立函数则放 `src/shared/`；**倾向把自动平衡计算放 `shared/decimal.ts`（Task 2 已含 `computeBalancingNumber`），视图内只做 Form 接线**，故本测试为组件接线冒烟）
- Modify: `src/renderer/src/App.tsx`（挂载录入视图）

**Interfaces:**
- Consumes: `ledgerStore`（status.operatingCurrency → 货币下拉数据源）、`addLedgerEntry` / `listLedgerAccounts`（AutoComplete 数据源）
- Produces: 录入表单（端到端入口）

- [ ] **Step 1: 表单骨架（ProForm）**
  - 字段：date `DatePicker`（默认今天，`format YYYY-MM-DD`）、flag `Radio.Group`（`*` 已确认 / `!` 未确认，默认 `*`）、payee `Input`、narration `Input`（maxLength 200）
  - postings：`Form.List name="postings"`，初始 2 行；每行：account `AutoComplete`（options ← `store.accounts`，`listLedgerAccounts` 挂载时拉取）、number `InputNumber`（**`stringMode` + `precision={4}`**，直取字符串防浮点）、currency `AutoComplete`（options ← `status.operatingCurrency`，可自由键入任意货币——首文件场景 operatingCurrency 为空则退化为纯输入）+ 删除按钮（行数 >2 时可删）
  - 校验规则：account `required` + pattern（含冒号、无空白、首字符大写字母）、number 可空仅限**最后一行**（`validator` 按 index 判断，末行空则跳过，否则 required）、currency `required`；postings 至少 2 行（Form.List rules）
- [ ] **Step 2: 自动平衡（接线）**
  - `const postings = Form.useWatch('postings', form)`
  - `useEffect`：行数 ≥2 且末行 `number` 为空/undefined → `computeBalancingNumber(前 n-1 行 number)` → `form.setFieldValue(['postings', lastIdx, 'number'], 差)`；**始终写入（含 `'0'`）**——若跳过而其余行和为 0，序列化会产出空金额 posting 导致 beancount 解析失败回滚，用户看到报错却不明原因
  - 触发时机：任一 posting number/account 变化（useWatch 天然覆盖）；与用户正在输入的末行互斥（末行 number 非空则不动，避免打字过程中被覆盖）
- [ ] **Step 3: 提交**
  - `submitter` 或 `onFinish`：values 归一化（date → `YYYY-MM-DD` 字符串、flag 默认 `*`、postings 过滤空行）→ `addLedgerEntry` → `message.success('已写入并校验通过')` + `form.resetFields()` + `store.refresh()`；reject → `message.error(String(err))`（保留表单内容供修改）
  - 提交中 loading 态（防重复提交）
- [ ] **Step 4: 验证**
  typecheck 绿；手工 dev 验证：填 2 行 → 末行自动补差 → 提交 → 明细 +1；余额不平场景前端拦截提示。

---

### Task 6: E2E 重写（M4 绿灯链路）

**Files:**
- Modify: `e2e/ledger-index.spec.ts`（重写为 M4 绿灯链路 + 失败场景）
- Modify: `e2e/smoke.spec.ts`（若引用旧 id / 旧按钮名，同步更新；smoke 应只断应用启动，检查后定）
- Add: `e2e/fixtures/setup.ts`（fixture 副本工具：`fs.copyFileSync(main.beancount, tmp)` → 返回副本路径，`beforeEach` 重建）

**Interfaces:**
- Consumes: Playwright electron.launch（`BEANWISE_LEDGER_PATH` 指向副本）；应用新 UI（role/text 定位，不复用已删 id）
- Produces: M4 绿灯验收自动化

- [ ] **Step 1: fixture 副本工具**
  `e2e/fixtures/setup.ts`：`mkdtempSync(os.tmpdir())` + `copyFileSync(python/tests/fixtures/main.beancount)` → 路径（5 entries 基线）；测试结束 `rmSync(recursive)`。

- [ ] **Step 2: 绿灯链路（重写 ledger-index.spec.ts）**
  1. 启动 → 默认进入「录入」视图；切「明细」→ 表格 5 行（断言含 `Breakfast`）
  2. 切「录入」→ 填：日期（默认今天即可）、payee「测试午饭」、narration「M4 E2E」、posting1 账户 `Expenses:Food` 金额 `25.50` 货币 `CNY`、posting2 账户 `Assets:Cash` 金额**留空**（验证自动平衡补 `-25.50`）
  3. 提交 → `message.success` 可见 → 切「明细」→ 6 行，新行含「测试午饭」
  4. **文件断言**：读副本文件，末块含 `2026-` 开头、`"测试午饭"`、`-25.50 CNY` 与 `25.50 CNY` 两 posting 行
- [ ] **Step 3: 失败场景（同 spec 追加）**
  5. 录一笔：两行金额手动填 `100.00` / `-99.00`（差 1.00，前端校验应拦截）→ 断言错误提示可见、副本文件内容不变（读文件长度/内容对比）
  6. （可选）首文件场景：`BEANWISE_LEDGER_PATH` 指向**不存在**的临时路径 → 录入成功 → 文件被创建且仅含该笔
- [ ] **Step 4: 全量验证**
  `npm run test:e2e`（本机需 `env -u ELECTRON_RUN_AS_NODE`）绿；CI ubuntu 头下同样绿（xvfb 已有）。

---

### Task 7: 文档同步 + M4 绿灯验收

**Files:**
- Modify: `technical-proposal/implementation-roadmap.md`（「IPC 契约」表补两通道；里程碑边界 M4 行补充定稿语义）
- Modify: `CLAUDE.md`（技术栈补 antd 依赖矩阵与 v5-patch；约束 #8 CSP 修订；「常见坑」可补 InputNumber stringMode / pro-components 不支持 antd v6 两条）
- Modify: `technical-proposal/data-consistency.md`（补「录入写失败 → 前置校验 + 索引 error 回滚」策略段落）

**Interfaces:**
- Consumes: Task 1-6 定稿的全部契约
- Produces: 文档与代码一致（roadmap 是全项目锚点）

- [ ] **Step 1: roadmap 同步**
  「IPC 契约」表追加：
  | `ledger:add-entry` | `{date, flag?, payee?, narration?, postings[]}` | `{ok, message?, status, entryCount, errorCount}` |
  | `ledger:list-accounts` | 无 | `{accounts: string[]}` |
  M4 边界行补注：金额十进制字符串、自动平衡、追加写 + truncate 回滚（引用 data-consistency.md）。
- [ ] **Step 2: CLAUDE.md / data-consistency.md 同步**
  见 Files 清单；约束 #8 措辞：生产 `default-src 'self'; style-src 'self' 'unsafe-inline'`（antd CSS-in-JS，2026-08-09 裁决），`script-src` 仍禁 inline/eval。
- [ ] **Step 3: 绿灯验收（对照 roadmap M4 行）**
  - `npm run typecheck` 绿
  - `npm run test:unit` 全绿（含新增 serializer / decimal / handler 测试）
  - `npm run test:e2e` 绿（绿灯链路 + 失败场景）
  - 手工双确认：`npm run dev` 录一笔 → 文件含该笔 → 明细可见；`BEANWISE_LEDGER_PATH` 指向空路径录首笔 → 文件自动创建
  - 全部通过后：roadmap 执行节奏进入下一里程碑（M5）

---

## M4 绿灯验收汇总

| 验收项 | 方式 | 判定 |
|---|---|---|
| ProForm 录一笔 → 落文件 | E2E Step 2-4 + 手工 | 文件末块含序列化交易文本 |
| 校验（借贷平衡） | 单测 + E2E Step 3 | 不平则拦截、文件不变 |
| 索引更新（端到端） | E2E Step 2.3 | 明细条目 5→6 |
| 首文件自动创建 | E2E Step 3.6 / 手工 | 空路径录首笔成功 |
| 自动平衡 | E2E Step 2.2 | 末行自动补 `-25.50` |
| typecheck / 单测 / E2E | CI + 本机 | 全绿 |

## M5 交接说明（不在本计划内）

- **编辑已有交易**：M5 Monaco 需要「读文件内容」能力（新增 `ledger:read-file` 或直接 renderer 侧由主进程代理读）；保存链路复用 M3 `refreshIndex` 与 M4 的「写入 → 校验 → 回滚」模式（整文件覆盖写 + 同款回滚）
- **serializer 扩展点**：tags / links / cost 语法在 `entry-serializer.ts` 内加分支即可，`validateEntryParams` 同步放宽
- **「按日期重排」整理功能**：M4 决定末尾追加，M5 有 Monaco 后可评估增加排序整理（不改 M4 契约）
- **应用壳导航**：录入 / 明细两视图已占位，M5 加「编辑器」导航项即扩展
- **pro-components 3.x beta（antd v6 栈）**：M8 图表期或 3.x 正式版发布时再评估迁移，M4-M7 锁定 antd 5 + pro-components 2.x
