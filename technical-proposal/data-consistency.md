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

## SQLite 索引设计要点

- 按日期 / 账户建索引，支撑图表聚合查询
- 解析结果缓存（文件 mtime + hash 判空跳过）
- 增量解析失败时回退全量解析，并记录日志

## git 同步与冲突处理

- 同步引擎：isomorphic-git（纯 JS 实现 git 协议，无原生依赖），目标 GitHub 私有仓库
- PAT：用户使用时输入，safeStorage 加密本地化存储，不落盘明文
- 冲突：三路合并 UI（base / ours / theirs，基于 Monaco DiffEditor 自研）人工合并
- 推送失败（网络 / 权限）：本地保留变更，状态栏提示重试