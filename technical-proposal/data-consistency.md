# 数据一致性原则

## 核心约定

```plain
Beancount 文件 ──唯一事实源──▶ 变更后增量解析 ──▶ 重建 SQLite 索引
                                    ▲
  所有写入（ProForm / AI / 手动编辑）都先落到文件，再同步索引
```

- **Beancount 文件是唯一事实源（Single Source of Truth）**
- SQLite 只是索引 / 缓存，任何时刻可全量重建
- 禁止绕过文件直接写 SQLite

## 工作目录隔离（M9 定稿，2026-08-22）

- 应用按「工作目录」组织账本运行时：账本文件、`.beanwise/index.db` 索引、`.beanwise/sync-config.json` 同步配置、`.beanwise/accounts.json` 账户库、`.git` 仓库均各目录独立
- **切换即整体重建**：`activateWorkspace` 先关旧 DB → 重建 db / GitSync / 配置 → 索引 fire-and-forget 刷新；成功后渲染端整页 reload，各域 zustand store 不跨目录残留状态
- 同步配置（repoUrl/branch/adopted/lastSyncAt/lastError）属账本仓库，因此存 `<workspace>/.beanwise/sync-config.json`（`JsonSyncConfigStore`）而非应用全局 userData
- PAT / API Key 经 safeStorage 加密后存 electron-store（`sync-tokens` 按工作目录路径小写键隔离、`ai-tokens`），**不落工作目录**——避免凭据进 git 仓库

## 写入路径

1. 用户录入（ProForm / AI / Monaco 编辑）
2. 主进程调用 Python `parse_file` / `validate` 校验
3. 校验通过 → 写回文件 → 增量解析 → 更新 SQLite 索引
4. 触发 git 同步（isomorphic-git）

### 录入写失败策略（M4 定稿，2026-08-09）

1. **前置校验**：入参校验（`validateEntryParams`：类型/日期/flag/长度/账户格式/金额正则）+ 借贷平衡校验（`computeBalancingNumber` 十进制字符串精确加法，禁 `parseFloat`/`Number`）——非法直接拒绝（invoke reject），文件零改动
2. **追加写**：文件尾非 `\n` 先补换行再追加；**首文件**（ENOENT）自动创建目录 + 文件，并补交易账户的 `open` 行（beancount v3 对未 open 账户报 ValidationError，实测 2026-08-09；同日 open + 交易 0 错误；不生成 options 模板）
3. **校验 + 重建**：写后立即调 `refreshIndex`（parse_entries 校验 → 事务重建索引）
4. **回滚**：索引 `status='error'`（前置校验已拦绝大部分，理论上仅漏网）→ `truncateSync(preLength)` 回滚到追加前长度；回滚失败记日志、status 保持 error（留 M5 手工修复）
5. **结果**：成功 `{ok:true}`；失败 `{ok:false, message}`（UI 提示，文件与索引保持一致）

## SQLite 索引设计要点

- 按日期 / 账户建索引，支撑图表聚合查询
- 解析结果缓存（文件 mtime + hash 判空跳过）
- 增量解析失败时回退全量解析，并记录日志

## git 同步与冲突处理（M6 定稿，2026-08-10）

- 同步引擎：isomorphic-git（1.41.3，纯 JS 实现 git 协议，无原生依赖），封装为 GitSync（init/commit/fetch/analyzeMerge/mergeFile）；账本目录即 git 工作区（唯一事实源铁律），只追踪账本文件，分支固定 `main`、remote 固定 `origin`；远端操作统一 30s 超时
- 传输：**isomorphic-git 1.x 不支持 file:// 本地传输**（1.x 已移除），测试/E2E 用进程内 smart-HTTP 服务器（`src/main/git-test-server.ts`）替代；URL 校验放行测试通道 `http://127.0.0.1:<port>` / `http://localhost:<port>`（仅回环）+ 生产通道 `https://github.com/owner/repo`
- PAT：用户使用时输入，safeStorage 加密后 base64 落 electron-store（`sync-tokens`，**按工作目录路径键隔离**，M9 起由 `ElectronWorkspaceTokenStore` 持有），不落盘明文、渲染进程 state 无 PAT；同步配置（repoUrl/branch/adopted/lastSyncAt/lastError）存 `<workspace>/.beanwise/sync-config.json`（`JsonSyncConfigStore`）
- 首同步三场景：A 空仓（init + commit + push -u）；B 本地无账本（clone 到账本目录）；C 两端都有内容（init + commit + fetch + analyzeMerge 接管：内容一致 → force push；不一致 → 三路快照，base 空串）
- 自动同步：**保存后自动 push 仅挂编辑器保存链路**（`saveEditorFile` 成功 → fire-and-forget push，失败不阻塞保存；未配置同步时静默跳过）；add-entry / AI 录入不触发（M7 交接）；手动 pull 独立通道；自动定时同步可后置（sync:push/pull 即定时器执行体）
- 合并：push/pull 前置快照提交（工作区脏 → commit）→ fetch → analyzeMerge 五分支（up-to-date / local-ahead→push / fast-forward / clean-merge / conflict）；**fast-forward 与 clean-merge 用 diff3 自动合并**（`GitSync.mergeFile`，同 isomorphic-git 内置算法，无冲突返回合并文本）→ 合并结果走「tmp 校验 + rename」管线（`writeLedgerChecked`，与 M5 保存同管线，校验失败不落盘）→ **双亲合并提交**（parents = [HEAD, 远端]，真实 git 合并语义，保证 push 客户端快进检查通过）→（push 时）push → `refreshIndex` 重建索引
- 冲突：仅冲突才弹三路合并 UI（base / ours / theirs 快照**内存传递**，不写冲突标记文件；三路 UI = 上双 DiffEditor（base vs ours / base vs theirs）+ 下 merged 可编辑，基于 Monaco 自研）；resolve 提交 merged 内容 → tmp 校验落盘 → 双亲合并提交 → push（adopted 场景 force）→ refreshIndex
- 推送失败（网络 / 权限 / 校验失败）：本地提交/文件保留，lastError 落状态条提示重试；**pull 只拉不推**（只读 PAT 不失败、不静默发布本地改动）
- syncing 互斥：push / pull / configure / resolve 任一进行中，其余触发即拒绝（writeLock 之外的第二道闸）