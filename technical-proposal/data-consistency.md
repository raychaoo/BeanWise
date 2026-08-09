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

## git 同步与冲突处理

- 同步引擎：isomorphic-git（纯 JS 实现 git 协议，无原生依赖），目标 GitHub 私有仓库
- PAT：用户使用时输入，safeStorage 加密本地化存储，不落盘明文
- 冲突：三路合并 UI（base / ours / theirs，基于 Monaco DiffEditor 自研）人工合并
- 推送失败（网络 / 权限）：本地保留变更，状态栏提示重试