# M7 AI 辅助录入设计（Design Spec）

> 状态：定稿（2026-08-11）
> 依据：roadmap「M7 | AI 辅助录入 | M3 | 自然语言 → 交易指令 → 落盘全链路；schema 校验拒绝非法输出」；ADR 12（Function Calling + 主进程 schema 校验）、ADR 13（主进程代理）；
> 范围裁决（2026-08-11 用户逐项确认）：纳入「单次生成 + 草稿确认」「录入页内嵌 AI 区块」「多笔（数组）生成」「设置 Modal + 页内引导」「账户列表注入 system prompt」；不纳入「多轮追问」「流式输出」「提示词工程打磨」；方案 A 定稿（最小全链路，B/C 记为 M8 后置候选）。

## 1. 目标与绿灯验收

**目标**：落地 AI 辅助录入链路——DeepSeek API Key 配置（safeStorage 加密）→ 自然语言 → 主进程代理 Function Calling（强制 tool 调用）→ 主进程按 schema 校验 → 草稿列表回渲染端 → 用户「填入表单」确认 → 复用 `ledger:add-entry` 落盘管线；非法输出一律拒绝并返回中文原因。

**绿灯验收**（roadmap M7 行）：自然语言 → 交易指令 → 落盘全链路；schema 校验拒绝非法输出。

## 2. 技术选型（定稿）

| 决策点 | 结论 | 理由 |
|---|---|---|
| AI 结构化输出 | **Function Calling（单 tool `add_entries`）+ 客户端 zod 校验** | ADR 12 定稿：deepseek-v4-flash 的 `json_schema` 模式不稳定（实测 400）；tool schema 即结构约束，输出仍须本地校验 |
| 请求通道 | **主进程代理**（全局 fetch + `AbortSignal.timeout(60s)`） | ADR 13 定稿：Key 不落渲染进程；CSP 零改动（fetch 在主进程，不受渲染 CSP 约束） |
| Schema 单一来源 | **zod 4**：一份定义 → `z.toJSONSchema()`（tool 参数）+ `zod.parse`（本地校验）+ `z.infer`（TS 类型） | AI 输出不可预测，需强校验；一份定义杜绝「tool schema 与校验规则漂移」 |
| 强制工具调用 | `tool_choice: {type:'function', function:{name:'add_entries'}}` | 杜绝模型返回自由文本（自由文本无结构约束，校验层无法兜底） |
| Key 存储 | `ElectronAiTokenStore`（safeStorage 加密 → base64 → electron-store，store 名 `ai-tokens`） | 完全复刻 M6 PAT 模式（`sync-tokens`）；含内存注入版供单测 |
| 测试隔离 | baseUrl 注入 + 进程内 mock 服务器（`ai-test-server.ts`） | 真实 API 不稳定且计费；沿用 M6 git-test-server 模式 |
| 账户上下文 | system prompt 注入 `ledger:list-accounts` 结果（≤500） | 基础上下文（约束账户名一致性），不算提示词打磨（打磨留后） |
| 自动 push | **不触发** | M6 已定：自动 push 仅挂编辑器保存（saveEditorFile），add-entry / AI 录入不触发，M7 交接不改动 |

## 3. 主进程代理（ai 域）

### 3.1 IPC 契约（`src/shared/ipc.ts` 类型唯一来源）

| 通道 | params | result 要点 |
|---|---|---|
| `ai:get-status` | 无 | `AiStatus { configured, model?, lastError? }`（**不含 Key**，渲染端永不接触密钥） |
| `ai:save-config` | `{ apiKey }` | `{ ok, error? }`（Key 仅经此通道上传，渲染端不落 state——同 `sync:configure` PAT 口径） |
| `ai:clear-config` | 无 | `{ ok }` |
| `ai:parse` | `{ text }`（≤2000 字符） | `{ ok, drafts?: AddEntryParams[], message?, error? }` |

关键类型复用：`drafts` 直接为 `AddEntryParams[]`（M4 定稿契约：date/flag/payee/narration/postings + 十进制字符串金额）——AI 输出与手动录入共享同一类型契约，草稿回填 ProForm 零转换。

失败语义（绿灯「schema 校验拒绝非法输出」落点）：结构非法 → `ok:false + error`（含具体字段原因）；API 层失败（401/402/429/5xx/超时/网络）→ `ok:false + error` 中文提示。`message` 留作模型可选附带说明。

### 3.2 Schema（`src/main/ai-schema.ts`）

`addEntriesToolSchema = z.object({ entries: z.array(AddEntrySchema) })`，字段口径对齐 M4 入参校验：

- 日期 `^\d{4}-\d{2}-\d{2}$`（真实日期，业务合法性由 add-entry 管线把关）
- 金额十进制字符串正则 `^-?\d+(\.\d+)?$`（**宽容分界**：JSON number 如 `12.5` coerce 为 `"12.5"`——无歧义转换，容忍模型类型漂移）
- 账户 `^[A-Z][\w:]*$` 无空白、currency 非空 ≤24 字符、postings 2~20 行、payee/narration ≤200 字符无控制字符
- **严格拒绝**：日期格式、账户格式、金额非数字、笔数越界——拒绝原因逐字段映射中文 error

三处使用：`z.toJSONSchema()` → tool parameters；`zod.parse` → 本地校验；`z.infer` → `AiAddEntriesArgs`（结构对齐 `AddEntryParams[]`）。

### 3.3 请求编排（`src/main/ai-proxy.ts`）

```
端点常量 https://api.deepseek.com/chat/completions（baseUrl 可注入，测试用）
POST { model: 'deepseek-v4-flash',
       messages: [system(固定模板 + 账户列表注入), user(text)],
       tools: [{type:'function', function:{name:'add_entries', description, parameters: toJSONSchema}}],
       tool_choice: 强制 add_entries }
→ 解析 choices[0].message.tool_calls[0].function.arguments（JSON string）→ zod.parse
→ 无 tool_calls / arguments 非 JSON / 校验失败 → 拒绝 + 中文原因
```

### 3.4 错误映射与日志

| 场景 | 提示 |
|---|---|
| 401 | 「API Key 无效，请检查 AI 设置」 |
| 402 | 「DeepSeek 账户余额不足」 |
| 429 / 5xx | 「AI 服务繁忙，请稍后重试」 |
| 超时 / 网络 | 「AI 请求超时 / 网络错误」 |
| 校验失败 | 「AI 输出不符合录入格式：<字段原因>」 |

electron-log 脱敏：不记 Key、不记请求原文；可记 token 用量。

### 3.5 Key 存储（`src/main/token-store.ts` 追加）

`ElectronAiTokenStore implements TokenStore`（store 名 `ai-tokens`，key `apiKey`，safeStorage 加密；`save` 在 safeStorage 不可用时抛中文 Error——复刻 PAT 语义）。

## 4. 渲染端（`src/renderer/src/views/AiEntryPanel.tsx`）

嵌入 EntryFormView 顶部（Collapse「AI 辅助录入」）：

```
输入自然语言 → 「生成草稿」(loading/禁用防重入)
  → 成功: 草稿列表（每笔一卡：date/flag/payee/narration/postings 只读摘要）
  → 每卡「填入表单」→ ProForm 回填 → 用户用现有「提交」按钮落盘（复用 M4 链路）
  → 失败: Alert 展示 error（含 schema 拒绝原因）+ 重试按钮
  → 未配置 Key: 引导提示 + 「去设置」按钮
```

- **写路径唯一**：AI 区块只负责「生成草稿」，落盘一律走 ProForm 现有提交 → `ledger:add-entry`（业务校验、追加写、索引重建全部复用 M4 已测管线，M7 不加第二条写路径）
- **草稿状态**：`useState` 局部状态（无跨视图需求，不建 store）；成功/填表后清空或标记
- **设置入口**：App.tsx Header 设置区新增「AI 设置」按钮 → 新组件 `AiSettingsModal.tsx`（仿 SyncSettingsModal：填 Key → `ai:save-config`，清空 → `ai:clear-config`）；`ai:get-status` 驱动 Header Tag 显示已配置/未配置

## 5. 数据流与错误处理

```
用户输入自然语言
 → AiEntryPanel → ai:parse (IPC, ≤2000字符)
 → main ipc-handler-ai → DeepSeekProxy.request()
 → fetch api.deepseek.com（tool_choice 强制 add_entries）
 → 解析 tool_calls arguments → zod 校验
 → AddEntryParams[] 回传渲染端 → 草稿列表
 → 用户「填入表单」→ ProForm 确认 → ledger:add-entry
 → 追加写 + Beancount 校验 → 索引重建 → 完成
```

| 层 | 失败场景 | 处理 |
|---|---|---|
| 渲染端 | 空输入 / 超长输入 | 本地禁用 + 提示（不发 IPC） |
| IPC | text 非字符串 / 超 2000 字符 | handler 入参校验拒绝 |
| 代理 | HTTP 401/402/429/5xx、超时、网络 | 映射中文 error（§3.4） |
| 校验 | 无 tool_calls、arguments 非 JSON、zod 校验失败 | 「AI 输出不符合录入格式：<原因>」 |
| 落盘 | add-entry 业务失败 | 复用 M4 表单错误展示，不新建 |

安全边界：主进程 fetch 不受渲染 CSP 约束，CSP 零改动；Key 仅主进程 safeStorage；日志脱敏。

## 6. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| schema | `src/main/ai-schema.test.ts` | zod 字段口径（日期/金额/账户正则）、number→string coerce、拒绝场景、`toJSONSchema` 与 zod 规则一致 |
| 代理 | `src/main/ai-proxy.test.ts` | `vi.stubGlobal('fetch')`：成功 tool call、arguments 解析、非法输出拒绝（绿灯核心）、401/402/429/5xx/超时、无 tool_calls、baseUrl 注入 |
| IPC | `src/main/ipc-handlers-ai.test.ts` | `ai:parse` 入参校验（空/超长）、`ai:save-config` 调 token store（内存注入）、三通道错误透传 |
| 渲染 | `src/renderer/src/views/ai-entry-panel.test.tsx` | 交互流：输入→loading→草稿展示→填入表单回调、失败 Alert + 重试、未配置引导 |
| E2E | `e2e/ai-entry.spec.ts` + `src/main/ai-test-server.ts` | 本地 mock DeepSeek 端点：「自然语言→草稿→填表→提交→索引更新」全链路；mock 非法输出 → 校验拒绝提示可见 |

不引入真实 API 调用（不稳定 + 计费），E2E 全程走进程内 mock server——与 M6 git-test-server 同一策略。

## 7. 边界（明确不做）

| 不做 | 留待 |
|---|---|
| 多轮追问（ask_clarification tool） | M8 后置候选（方案 B） |
| 流式输出 | M8 后置候选（方案 C） |
| 提示词工程打磨 | 方案文档外持续演进 |
| 模型/温度等参数 UI | 常量硬编码，后续可配置 |
| AI 录入触发自动 push | M6 已裁决不触发 |
