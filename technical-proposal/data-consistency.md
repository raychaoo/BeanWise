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

## git 同步与冲突处理（M6 定稿 2026-08-10；M11 扩展为文件集；M12 加本机代理 2026-09-17；M13 加提交人身份 2026-09-18）

- 同步引擎：isomorphic-git（1.41.3，纯 JS 实现 git 协议，无原生依赖），封装为 GitSync（init/addTrackedFiles/ensureGitignore/commit/fetch/analyzeMerge/blobTextAt）；账本目录即 git 工作区（唯一事实源铁律），**同步范围见下一节**，分支固定 `main`、remote 固定 `origin`
- 传输：**isomorphic-git 1.x 不支持 file:// 本地传输**（1.x 已移除），测试/E2E 用进程内 smart-HTTP 服务器（`src/main/utils/test-servers/git-test-server.ts`）替代；URL 校验放行测试通道 `http://127.0.0.1:<port>` / `http://localhost:<port>`（仅回环）+ 生产通道 `https://github.com/owner/repo`
- PAT：用户使用时输入，safeStorage 加密后 base64 落 electron-store（`sync-tokens`，**按工作目录路径键隔离**，M9 起由 `ElectronWorkspaceTokenStore` 持有），不落盘明文、渲染进程 state 无 PAT；同步配置（repoUrl/branch/adopted/lastSyncAt/lastError）存 `<workspace>/.beanwise/sync-config.json`（`JsonSyncConfigStore`）
- 首同步三场景：A 空仓（init + 纳管/提交 + push -u）；B 本地无内容（clone 到账本目录；判据是**任一内容文件非空**，见下）；C 两端都有内容（init + 纳管/提交 + fetch + analyzeMerge 接管）
- 自动同步：**保存后自动 push 挂三条链路**——编辑器保存（`saveEditorFile`）、账户库保存（`saveAccountConfig`）、Excel 模板保存/删除/导入（`ExcelImportPanel`）；均 fire-and-forget，失败不阻塞保存，未配置同步时静默跳过；add-entry / AI 录入不触发（M7 交接）；手动 pull 独立通道
- 合并：push/pull 前置 `addTrackedFiles` + 快照提交 → fetch → analyzeMerge（up-to-date / local-ahead / **merge**）→ 逐文件三路合并（`core/merge-engine.ts`，纯函数）→ **两阶段落盘**（先全部校验：账本 tmp + Python `parse_entries`、JSON 解析 + 结构化校验；全部通过才 rename/写盘）→ **双亲合并提交**（parents = [HEAD, 远端]，真实 git 合并语义，保证 push 客户端快进检查通过）→（push 时）push → `refreshIndex` 重建索引
- 冲突：只有**逐文件三路推导不出结果**才弹合并 UI（三路快照 base/ours/theirs **内存传递**，不写冲突标记文件）；resolve 提交逐文件决议 → 两阶段落盘 → 双亲合并提交 → push（adopted 场景 force）→ refreshIndex；并带过期快照防护（re-fetch 比对远端 oid）
- 快照提交的脏判定：**逐追踪文件比对 HEAD blob 与工作区**（不用 `statusMatrix` 全工作区扫描——未跟踪文件会让 `head !== workdir` 恒真，曾导致每次 push 产生空提交）
- 推送失败（网络 / 权限 / 校验失败）：本地提交/文件保留，lastError 落状态条提示重试；**pull 只拉不推**（只读 PAT 不失败、不静默发布本地改动）
- syncing 互斥：push / pull / configure / resolve 任一进行中，其余触发即拒绝（writeLock 之外的第二道闸）
- **本机代理与超时（M12）**：GitHub 直连不可达时同步只剩「git 操作超时（30000ms）」，无从下手。故同步设置新增「本机网络」区——**代理地址**（只支持 HTTP/HTTPS，手动填写，不读系统代理/环境变量；拒绝携带用户名密码，密钥只进 safeStorage）与**超时**（1~600 秒，默认 30）。代理经 `core/git-network.ts` 包一层 http 插件注入 `agent`（isomorphic-git 顶层命令不接受 `agent`，只有插件层收并透传给 simple-get，见 ADR 29）；配置存**机器级** electron-store `git-network`（不随工作目录、不进仓库），`network()` 每次远端调用求值 → 改完立即生效；**目标为本机回环时一律绕过代理**（否则配了代理连测试用的进程内 git 服务器都走代理）。三个通道：`sync:get-network` / `sync:save-network`（非法地址返回 ok:false 而非 reject）/ `sync:test-connection`（用已保存配置做真实 git 握手 `listServerRefs`，把「代理没开」「代理没放行」「PAT 不对」分开报）
- **提交人身份（M13）**：M12 修掉超时后暴露的下一个问题——提交人硬编码 `BeanWise <beanwise@local>`，GitHub 按邮箱归属账号，这些提交不属于任何人。**三级优先：手填 > PAT 识别 > 内置兜底**。手填「姓名 + 邮箱」（两个都填才生效）存**机器级** electron-store `git-identity`；识别用该目录的 PAT 调 `GET /user`，提交邮箱拼 `<id>+<login>@users.noreply.github.com`（**绝不用响应里的 `email`**：私有邮箱时为 null，且可能未在该账号验证 → 会把提交算到别人名下）。识别缓存按**工作目录**键隔离（与 PAT 同域，共用 `utils/workspace-key.ts`）——否则换目录会把上一个账本的 GitHub 身份带过来，新账本首个提交就挂错人；`sync:clear` 清识别缓存、保留手填值。`resolveGitIdentity` 是纯函数、**提交路径绝不联网**（识别只发生在 configure 成功后 best-effort 与用户点按钮两处）。识别走 `https.request` + `proxyAgentFor`（全局 `fetch` 不吃应用内代理）；`formatAuthor` 零转义 → 手填值拒绝换行/尖括号（防往 commit 对象注入头行），识别值净化（退化则用 login）。身份只影响**之后**的提交，已有历史不改写（见 ADR 30）

## 同步文件集与合并算法（M11 定稿，2026-09-17）

账本之外的「重建成本高、纯用户数据」的文件必须随仓库走，否则换电脑后账户库与模板要重配。单一事实源在 `src/shared/sync-files.ts`：

| 文件 | 是否提交 | 理由 |
|---|---|---|
| `main.beancount` | ✅ | 唯一事实源 |
| `.beanwise/accounts.json` | ✅ | 账户库（科目/用途/停用/往来标记），重建成本高 |
| `.beanwise/excel-import-templates.json` | ✅ | Excel 导入模板（列映射/方向规则/账户映射） |
| `.gitignore` | ✅（受托管块） | 让忽略规则随仓库传播到新机器 |
| `.beanwise/index.db`（含 `-wal`/`-shm`） | ❌ 忽略 | 可从账本重建的索引缓存，二进制、高频变动 |
| `.beanwise/sync-config.json` | ❌ 忽略 | lastSyncAt 每次同步都变（提交噪声）；且新机器会出现「显示已配置但本机无 PAT」的错位。**换电脑需重新填写仓库地址 + PAT**（有意设计） |

- **`.gitignore` 纳管**：`GitSync.ensureGitignore()` 幂等——文件缺失则创建、有内容无 marker 则追加托管块（`# >>> BeanWise 同步托管块 >>>`）、已含 marker 则不动；**绝不覆写用户自己的规则**。由 `addTrackedFiles()` 统一调用（唯一入口）。
- **`git.add` 必须 `force: true`**：isomorphic-git 的 `addToIndex` 对「未跟踪且被 .gitignore 命中」的路径**静默跳过**——用户自己的 `.gitignore` 若写了 `.beanwise/`，账户库会永远同步不出去。同理 `git.commit` 取的是索引而非工作区，故每次提交前必须 `addTrackedFiles()`（含对已删除文件的 `git.remove`）。
- **三态语义**（`mergeThreeWay`，ours/base/theirs 各自可为 `null` = 该侧无此文件）：

| ours vs base vs theirs | 结果 |
|---|---|
| ours = theirs | unchanged（不动工作区） |
| base = theirs（仅本地改/删） | unchanged（本地内容即正确结果） |
| base = ours（仅远端改） | write(theirs)；远端删除 → delete |
| 两侧都改且不同 | 按文件类型分派（下） |
| 一方删除、另一方改写 | conflict |
| 账本文件推出 delete | 降级为 write('')——账本是产品主文件，不真删 |

- **文本文件**（账本、.gitignore）：diff3 行级合并（`textDiverged`），干净合并即落盘，否则 conflict。
- **JSON 文件**（账户库 / Excel 模板）：**结构化并集**（`unionMerge`）——按语义键（账户库按 `value`、模板按 `source`）逐条三路推导：两侧同改同一条目且内容不同 → conflict，否则并集。**收敛性是命门**：机器 A 拉取时 ours=A/theirs=B，机器 B 拉取时 ours=B/theirs=A，两者必须得到逐字节相同的结果，否则每次同步都产生新差异（ping-pong）。保证手段：遍历按 key 升序、id 分配只看已占用集合、需要「取一侧 id」时统一取 min、新 id 由 (key,n) 纯函数派生（账户库为自增整数，模板为 `sha1(source:n)`）。属性测试锁死（`src/main/core/merge-engine.test.ts`）。
- **id 重排是安全的**：`AccountEntry.id` 只用于界面排序与 ProTable rowKey，账本与 SQLite 索引都不引用；合并时 base 中出现的 id 一律视为已占用（含已删除条目），新条目优先沿用 `min(两侧 id)`、被占用则顺延。
- **首同步场景 B 的判据**从「账本非空」改为「**任一内容文件非空**」：账本为空但账户库已配置的目录不再被 clone 覆盖，改走场景 C 合并。
