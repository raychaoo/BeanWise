# M6 Git 同步设计（Design Spec）

> 状态：定稿（2026-08-10）
> 依据：roadmap「M6 | Git 同步 | M3 | 推拉到 GitHub 私有仓库；人为冲突 → 三路合并 UI 完成合并」；ADR 9（自研三路合并 UI）、ADR 11（isomorphic-git）；
> 范围裁决（2026-08-10 用户逐项确认）：纳入「保存后自动 push + 手动 pull」「GitHub 手动建空仓 + 应用内 init/push」「diff3 自动合并 + 冲突才弹三路 UI」「上双 Diff + 下 merged 编辑」「本地裸仓 E2E + GitHub 实仓手工验收」；不纳入「自动定时同步」「逐块合并选择器」。

## 1. 目标与绿灯验收

**目标**：落地 Git 同步链路——PAT 录入（safeStorage 加密）→ 保存后自动 push / 手动 pull → 远端分叉时 diff3 自动合并 → 冲突才弹三路合并 UI → 人工决策 → 校验落盘 → commit → push；推送失败本地保留 + 状态条提示重试。

**绿灯验收**（roadmap M6 行）：推拉到 GitHub 私有仓库；人为冲突 → 三路合并 UI 完成合并。

## 2. 技术选型（定稿）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 同步引擎 | **isomorphic-git**（纯 JS，零原生依赖） | ADR 11 定稿；Electron 内免编译；支持本地路径仓库（E2E 用裸仓模拟） |
| 合并算法 | isomorphic-git `mergeFile`（diff3 三路合并，纯 JS） | 单文件账本场景等价于仓库级 merge；账本为「追加型」文本，diff3 对追加几乎 100% cleanMerge，冲突 UI 只处理真正分叉 |
| 冲突输入 | **纯内存三路快照**（base/ours/theirs blob 内容），工作区永无 `<<<<<<<` 标记文件 | 不污染唯一事实源；UI 输入干净；M5 DiffEditor 双 model 模式直接复用 |
| PAT 存储 | Electron `safeStorage.encryptString` → base64 → electron-store | ADR 1 定稿（safeStorage）；渲染进程不接触密钥（ADR 10） |
| 配置存储 | electron-store（userData 下 JSON） | 非敏感配置（repoUrl/branch/lastSyncAt）明文即可 |
| 合并 UI | 上双 DiffEditor（ours/theirs 只读）+ 下 merged 可编辑 Monaco（beancount 高亮）+ 三按钮 | ADR 9 定稿；M5 冲突面板双 model 组合复用；用户裁决「上双 Diff + 下 merged 编辑」 |

## 3. 同步流程（数据流铁律延伸）

### 3.1 自动 push（保存成功触发）

```
保存成功（M5 save-file 管线）→ 自动触发 GitSync.push：
  1. commit 本地改动（message 固定「save: <ISO 时间>」）
  2. fetch origin（超时 30s）
  3. 远端无新提交 → push（快进）
  4. 远端有 → diff3 自动合并：mergeFile(ours=HEAD blob, theirs=origin/main blob, base=merge-base blob)
     ├─ cleanMerge → 合并结果 → 校验落盘（tmp+rename 复用 M5 管线）→ commit → push
     └─ 冲突 → 返回 {conflict, base, ours, theirs} → 渲染端弹三路合并 UI
  5. 推送失败（网络/权限/未配置）→ 本地已 commit 保留，状态条提示重试，不阻塞保存
```

### 3.2 手动 pull

```
fetch origin → 远端无新提交 → {ok, upToDate:true}
             → 有 → diff3 自动合并（同 3.1 第 4 步）
                 ├─ 快进/cleanMerge → 工作区文件更新 → refreshIndex → {ok}
                 └─ 冲突 → {conflict, base, ours, theirs} → 三路合并 UI
```

### 3.3 冲突解决（sync:resolve-conflict）

```
merged 内容入参 → tmp 校验（M5 管线语义：写同目录 tmp → parse_entries → 失败删 tmp 拒绝）
  → rename 原子替换 → commit（message「merge: 手动解决冲突」）→ push → refreshIndex
```

### 3.4 关键决策

- **自动 push 失败不阻塞保存**——保存成功照常提示，同步状态降级为「同步失败，可重试」（data-consistency.md「推送失败：本地保留变更，状态栏提示重试」）
- **pull/合并成功后必须 refreshIndex**——工作区文件变了，索引联动是铁律
- **合并结果落盘走「tmp 校验 + rename」**——merged 内容非法则拒绝落盘、UI 弹错误提示，与 M5 语义一致
- **git 同步与索引解耦**——索引 error 不影响 push（文件仍是事实源）
- **commit 与合并流程互斥**：push/pull 进行中（syncing）拒绝并发触发；保存自动 push 与手动 pull 通过主进程侧锁串行化

## 4. Git 仓库形态与首次同步

- **账本目录即 git 工作区**（唯一事实源铁律强制）：不建独立 repo 副本、不用符号链接；git 只追踪账本文件本身
- 分支固定 `main`（GitHub 默认）；remote 固定 `origin`；单仓库单账本
- 空仓库由用户在 GitHub 手动创建（PAT 只需 `repo` scope，无 GitHub API 依赖）

首次同步三场景（`sync:configure` 内自动判别）：

| 场景 | 本地 | 远端 | 动作 |
|---|---|---|---|
| A | 已有账本 | 空仓 | `init` → add 账本 → commit → remote add origin → push -u |
| B | 无账本 | 已有 | `clone` 到 ledgerPath → refreshIndex |
| C | 已有账本 | 已有（unrelated） | 内容一致 → 直接接管（init + commit + push）；不一致 → 三路合并 UI（base=空） |

## 5. 密钥与配置存储

- **PAT**：`safeStorage.encryptString` → base64 → electron-store（userData）；仅 git 操作时解密使用；electron-log 脱敏（如 `p•••d` 形式），禁止记录明文
- **配置**：repoUrl / branch / remote / lastSyncAt / lastError → electron-store 明文（非敏感）
- **可测性**：TokenStore 抽象为接口（`encrypt/decrypt` 可注入 mock——Linux CI 下 safeStorage 不可用）；GitSync 与存储解耦（依赖注入）

## 6. 新增 IPC 契约（类型唯一来源 `src/shared/ipc.ts`）

| 通道 | params | result 要点 |
|---|---|---|
| `sync:get-status` | 无 | `SyncStatus \| null`（configured / repoUrl? / branch? / lastSyncAt? / lastError? / syncing） |
| `sync:configure` | `{repoUrl, pat}` | `{ok, error?, status?}`（URL 格式校验 + ls-remote 测试连接 → 保存（PAT 加密）→ 触发首同步场景 A/B/C → 返回同步后状态） |
| `sync:push` | 无 | `{ok, conflict?, base?, ours?, theirs?, message?}`（commit → fetch → diff3 自动合并；conflict 时三路快照） |
| `sync:pull` | 无 | `{ok, conflict?, base?, ours?, theirs?, message?}`（fetch → 自动合并；成功 → 工作区更新 + refreshIndex） |
| `sync:resolve-conflict` | `{content}` | `{ok, status?, entryCount?, errorCount?, message?}`（tmp 校验 → 落盘 → commit → push → refreshIndex） |
| `sync:clear` | 无 | `{ok}`（清除配置与 PAT） |

- preload 白名单 6 方法（`getSyncStatus` / `configureSync` / `pushLedger` / `pullLedger` / `resolveSyncConflict` / `clearSync`）
- 入参校验：repoUrl 为 `https://github.com/...` 格式（正则 + URL 解析校验），pat 非空字符串 ≤200 字符；content 复用 M5 的 20MB 上限与字符串校验
- 主进程 `src/main/git-sync.ts` 封装 isomorphic-git（GitSync 类），handler 只做校验与编排

## 7. 渲染端

- **syncStore**（zustand，模式同 ledgerStore——actions 可 node 单测）：`status` / `syncing` / `conflict`（三路快照）/ actions（`loadStatus` / `configure` / `push` / `pull` / `resolveConflict` / `clear`）
- **同步设置 Modal**：Sider 底部「同步」入口 → Modal 内 repoUrl（Input）+ PAT（Password）+ 「测试连接」按钮 + 保存；已配置显示当前 repoUrl + 「重新配置」+「清除」
- **同步状态条**（Header 右侧）：未配置 → 「未配置同步」按钮（开设置 Modal）；已配置 → `main · 上次同步 HH:mm` + 状态（同步中 spinner / 失败 → 红色 Tag「同步失败，点击重试」/ 冲突 → 橙色 Tag「有冲突待处理」点击进合并视图）
- **保存自动 push 挂接**：`doSaveFile` 成功路径旁 `void syncStore.push()`（不 await；失败吞入 sync state，不打扰保存成功提示）
- **冲突视图**：Sider 导航新增「合并」项（仅冲突状态时显示 + badge）→ 上双 DiffEditor（ours/theirs 只读，M5 双 model 模式）+ 下 merged 可编辑 Monaco（beancount 高亮）+ Alert 引导 + 三按钮：
  - **采用本地**：merged ← ours
  - **采用远端**：merged ← theirs
  - **完成合并**：merged 当前内容 → `resolveSyncConflict`（校验失败 → 错误提示，merged 保留供修改）

## 8. 测试策略

| 层 | 覆盖 |
|---|---|
| main 单测 GitSync（temp dir + 本地 bare repo，注入式） | 首同步 A/B/C 三场景；快进 push；远端分叉 cleanMerge 自动合并；冲突检测（三路快照正确性：base=merge-base、ours=HEAD、theirs=origin/main）；resolve 落盘 + push；网络失败本地保留；syncing 互斥 |
| main 单测 TokenStore | 加密存取（mock encrypt/decrypt）、配置读写、脱敏 |
| renderer 单测 | syncStore：configure 成功/失败、push 冲突 → 状态落 store、resolve 成功/校验失败、保存自动 push 触发、pull 成功索引联动（refresh 调用） |
| E2E（本地裸仓，CI 可跑） | ① 绿灯：configure 本地 bare 仓 → 保存一笔 → 自动 push → 裸仓可见；② 冲突：远端先改 → 本地保存 push → 合并视图 → 采用本地 → 完成合并 → 裸仓为合并结果；③ pull 快进：远端新增 → 手动 pull → 文件更新 + 明细联动 |
| 手工验收（GitHub 实仓） | 真实私有仓库推拉 + 人为冲突合并（M6 绿灯验收项） |

## 9. 文档同步

- `technical-proposal/implementation-roadmap.md`：「IPC 契约」表补 `sync:*` 六通道；M6 边界行补定稿语义（diff3 自动合并 + 三路 UI、账本目录即工作区、保存后自动 push）
- `technical-proposal/data-consistency.md`：git 同步节补定稿细节（diff3 自动合并、冲突快照、resolve 管线）
- `technical-proposal/design-decisions.md`：ADR 9 / ADR 11 补落地结论
- `technical-proposal/tech-stack.md`：补 isomorphic-git / electron-store
- `CLAUDE.md`：技术栈补 Git 同步（isomorphic-git + safeStorage + electron-store）

## 10. 不做（M6 边界）

- ❌ 自动定时同步（roadmap 明确可后置）
- ❌ 多仓库 / 多远端 / 多账本文件
- ❌ git 历史可视化、非冲突 diff 视图
- ❌ OAuth 登录（PAT 已定）；❌ SSH 密钥
- ❌ 合并逐块选择器（M6 是「整侧 + 手动编辑 merged」，逐块留后）
