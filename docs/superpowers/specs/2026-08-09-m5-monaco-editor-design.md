# M5 Monaco 编辑器设计（Design Spec）

> 状态：定稿（2026-08-09）
> 依据：roadmap「M5 | Monaco 编辑器 + beancount 语法高亮、保存/校验、DiffEditor 基础」；
> 范围裁决（2026-08-09 用户确认）：纳入「外部修改冲突检测 + DiffEditor」，不纳入「错误定位到行」「按日期重排」「实时 lint」。

## 1. 目标与绿灯验收

**目标**：落地账本编辑器视图——Monaco 打开账本文件 → beancount 语法高亮 → 编辑 → 保存（整文件覆盖）→ 校验 → 索引重建；保存时检测外部修改冲突并用 DiffEditor 展示差异供用户决策。

**绿灯验收**（roadmap M5 行）：打开账本 → beancount 高亮 → 编辑保存 → 校验提示。

## 2. 技术选型（定稿）

| 决策点 | 结论 | 理由 |
|---|---|---|
| Monaco 集成 | 裸 `monaco-editor` + Vite `?worker` + `MonacoEnvironment.getWorker` | 零额外依赖；vite 8 原生 `?worker` 把 worker 打成独立 chunk，`worker-src 'self'` 即可加载，符合生产 CSP（禁 remote / unsafe-eval）；版本直接锁定 |
| 语法高亮 | 自研 monarch 语言定义（`registerLanguage` + `setMonarchTokensProvider`） | CLAUDE.md 约束「Monaco 需自定义 beancount 语法高亮，不要用默认语言模式」；词法级规则足够，无需语言服务 |
| 编辑器 UI | `monaco.editor.create` 直用（不用 @monaco-editor/react 封装） | 少一层间接；loader 默认 CDN 不符合 CSP，本地化配置反而绕 |
| 落盘策略 | 整文件覆盖：**写同目录临时文件 → parse 校验 → rename 原子替换** | 校验失败不污染唯一事实源（比 M4 的「写后 truncate 回滚」更干净）；rename 无半写窗口 |

## 3. 新增 IPC 契约（类型唯一来源 `src/shared/ipc.ts`）

| 通道 | params | result |
|---|---|---|
| `ledger:read-file` | 无（路径主进程持有，防目录穿越） | `{ok: boolean, content?: string, fingerprint?: string, message?: string}`；ENOENT → `{ok:false, message:'账本文件不存在'}` |
| `ledger:save-file` | `{content: string, expectedFingerprint: string}` | `{ok: boolean, conflict?: boolean, diskContent?: string, diskFingerprint?: string, fingerprint?: string, status?: LedgerIndexStatus, entryCount?: number, errorCount?: number, message?: string}` |

- conflict 时 `diskContent` + `diskFingerprint` 为**同一次读取**的快照（主进程一次读文件同时取内容与算指纹，无二次读取竞态），渲染端直接用于 DiffEditor original 侧与「强制保存」重试

- `fingerprint` = 文件 sha256 hex（复用 `src/main/index-builder.ts` 的 `sha256File`，导出共享；删除既有私有重复实现）
- 渲染进程不持有路径；preload 白名单加 `readLedgerFile` / `saveLedgerFile` 两方法

## 4. 保存管线（主进程 `ledger:save-file`）

```
入参校验（content 为 string、expectedFingerprint 为 sha256 hex 格式）
  ↓
sha256(磁盘当前内容) ≠ expectedFingerprint → 返回 {ok:false, conflict:true, diskContent, diskFingerprint}（不写盘）
  ↓ 一致
写同目录临时文件 ledgerPath + '.m5tmp'（utf8）
  ↓
engine.parseEntries(tmpPath) 校验（复用 M3 管线）
  ↓ 失败
删 tmp（best-effort）→ 返回 {ok:false, message}（原文件不动，错误内容不落盘）
  ↓ 通过
renameSync(tmp, ledgerPath)（原子替换；Node on Windows rename 覆盖已存在文件，MoveFileExW 语义）
  ↓
refreshIndex(db, engine, ledgerPath)（复用 M3 管线；失败保留旧索引，文件已合法替换——与 M4 一致，可经 Header 重建索引恢复）
  ↓
返回 {ok:true, fingerprint: sha256(新文件), status, entryCount, errorCount}
```

**与 M4 回滚策略的关系**：M4 append 是「写后校验 + truncate 回滚」（追加写无法先校验 tmp）；M5 整文件覆盖可先校验 tmp 再落盘，校验失败零污染。两者并存，各有适用场景。

## 5. 编辑器视图（EditorView）

- Sider 导航加「编辑器」项（FileTextOutlined 图标）；`view` 联合类型扩为 `'entry' | 'entries' | 'editor'`
- **视图保活**：三视图常驻 DOM、CSS `display` 切换——切走再回来编辑器状态不丢（Monaco 实例不销毁）
- 布局：顶部工具条（保存按钮 / 重载按钮 / 脏状态 Tag「未保存·已保存」）+ Monaco 主体（`language='beancount'`，vs 主题）
- 状态（`ledgerStore` 扩展）：`editorContent` / `editorOriginal`（打开时基线）/ `editorFingerprint`（打开时指纹）/ `editorDirty` / `editorSaving` / `editorConflict`（磁盘内容，冲突面板用）
- 数据流：
  1. 挂载（或切到编辑器视图首次）→ `readLedgerFile()` → 成功则内容入 store（基线 + 指纹）；`ok:false` → Empty 态「账本文件不存在，请先在录入视图录一笔创建」
  2. `onChange` → 与基线比对 → dirty（内容相等即不脏）
  3. Ctrl+S / 保存按钮 → 保存流程（下）
- **保存流程状态机**（抽独立 hook `useEditorSave`，纯逻辑可单测）：`idle → saving → success | conflict | error`
  - 无改动 → 提示「无更改」，不调 IPC
  - `conflict:true` → **冲突面板**：DiffEditor（original=磁盘最新内容 / modified=本地内容，只读）+ 三按钮：
    - **重新加载**：编辑器内容 ← 磁盘内容，更新基线 + 指纹，关闭面板
    - **强制保存**：以 `diskFingerprint` 为 expectedFingerprint 重试保存（覆盖外部修改）
    - **继续编辑**：关闭面板，留在编辑器（内容不动）
  - 校验失败（`ok:false` 非冲突）→ `message.error(message)`，编辑器内容保留供修改
  - 成功 → 更新基线（content = 保存内容、fingerprint = 返回新指纹、dirty=false）→ `store.refresh()`（Header 索引 Tag / 明细联动）
- 重载按钮：放弃本地修改，重新 `readLedgerFile()` 替换编辑器内容
- 编辑器挂载期间外部修改**不主动监听**（不做 fs.watch / 轮询）——检测时机为保存动作本身（保存时指纹比对），M5 最小语义

## 6. beancount 语法高亮（monarch）

`src/renderer/src/monaco/beancount-language.ts`：

- `registerBeancountLanguage(monaco)`：`registerLanguage({id:'beancount'})` + `setMonarchTokensProvider` + 注册主题规则（token → color）
- tokenizer 规则（顺序敏感）：
  1. 注释：`;` 至行尾
  2. 指令关键字：`option|plugin|include|pushtag|poptag|note|balance|open|close|event|query|custom|commodity|price`（行首）
  3. 日期：`\d{4}-\d{2}-\d{2}`（number 色）
  4. flag：`[*!#%&]`
  5. 字符串：`"…"`（含 `\"` 转义）
  6. 账户：`[A-Z][A-Za-z0-9-]*(:[A-Z][A-Za-z0-9-]*)+`（自定义 token，**先于**货币匹配）
  7. 金额：`-?\d+(\.\d+)?`
  8. 货币：`[A-Z][A-Z0-9']{1,8}`（无冒号，区别于账户）
  9. tags `#[A-Za-z0-9\-_/.]+` / links `\^[A-Za-z0-9\-_/.]+`
- 测试：mock monaco 冒烟（注册函数被调用、language id、tokenizer 定义存在）；tokenizer 规则表导出为纯数据，单测断言关键 token 模式存在

## 7. CSP 修订

- 生产：`default-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`（新增 `worker-src 'self'`——vite `?worker` 产出的独立 chunk 经 `new Worker(本地URL)` 加载）
- 开发模式：与现状对称，worker 同源加载无需额外放行（确认后如需则加 `worker-src 'self'` 保持显式）
- 同步：`src/main/csp.ts` + `csp.test.ts` + CLAUDE.md 约束 #8 + `technical-proposal/security.md`

## 8. 测试策略

| 层 | 覆盖 |
|---|---|
| 单测 main（temp dir + 真实 fs + mock engine） | read 正常 / ENOENT；save 成功（tmp→rename、refreshIndex 调用、返回新指纹）；指纹冲突（断言**不写盘**、返回 diskFingerprint）；校验失败（tmp 删除、原文件字节不变）；content/指纹入参非法 throw |
| 单测 renderer | monarch 语言注册冒烟；`useEditorSave` 状态机三分支（success / conflict / error）；dirty 判定（内容相等不脏） |
| E2E | ① 绿灯：切「编辑器」→ 内容加载 → 修改 → 保存 → 成功提示 + 明细联动；② 冲突：录入视图加一笔 → 编辑器改动 → 保存 → 冲突面板（DiffEditor 可见）→「重新加载」→ 编辑器回滚到磁盘内容；③ 失败：写坏（借贷不平）→ 保存 → 错误提示 + 文件字节不变 |

## 9. 文档同步

- `technical-proposal/implementation-roadmap.md`：「IPC 契约」表补 `ledger:read-file` / `ledger:save-file`；M5 边界行补定稿语义（tmp+rename 落盘、冲突检测、monarch 高亮）
- `CLAUDE.md`：技术栈补 Monaco（裸包 + `?worker` + monarch 自定义语言）；约束 #8 补 `worker-src 'self'`；「常见坑」可补 Monaco worker 打包结论
- `technical-proposal/tech-stack.md` / `security.md` / `design-decisions.md`（ADR 8 补落地结论）

## 10. 不做（M5 边界）

- ❌ 错误定位到行（用户裁决不纳入，2026-08-09）
- ❌ 实时 lint（防抖校验）；❌ 自动保存
- ❌ 「按日期重排」整理；❌ 账本选择器（路径主进程持有）
- ❌ 三路合并 UI（M6）；❌ 主题切换（antd 亮色 + vs 主题，M8 前不做暗色）
- ❌ fs.watch 外部修改监听（检测时机 = 保存动作，M5 最小语义；M6 git 同步后可评估）
