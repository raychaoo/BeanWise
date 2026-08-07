# BeanWise 复式记账桌面应用 · 技术文档
> BeanWise（豆账）——桌面端复式记账工具，以 Beancount 文件为唯一事实源，
> 支持 DeepSeek AI 辅助录入与 GitHub 私有仓库同步（chaoo/beanwise）。

> 桌面端复式记账工具，以 Beancount 文件为唯一事实源，支持 AI 辅助录入与 GitHub 私有仓库同步。

## 文档结构

| 文件 | 内容 | 读者 |
|---|---|---|
| [tech-stack.md](./technical-proposal/tech-stack.md) | 技术栈清单（框架 / 数据 / UI / 工程化） | 全体成员 |
| [architecture.md](./technical-proposal/architecture.md) | 整体架构、进程边界、数据流、通信协议 | 后端 / 全栈 |
| [implementation-roadmap.md](./technical-proposal/implementation-roadmap.md) | 里程碑拆分、共享契约、执行节奏 | 全员 / 执行者 |
| [design-decisions.md](./technical-proposal/design-decisions.md) | 关键设计决策与取舍记录（ADR） | 评审 / 新人 onboarding |
| [data-consistency.md](./technical-proposal/data-consistency.md) | 文件与索引的一致性、git 同步与冲突处理 | 后端 / 数据 |
| [security.md](./technical-proposal/security.md) | 密钥管理、CSP、IPC 白名单 | 全员 |
| [release-pipeline.md](./technical-proposal/release-pipeline.md) | CI/CD、签名、自动更新 | DevOps / 发布负责人 |

## 维护约定

- 本目录只放**已定稿**的决策；讨论中的内容放 issue 或 design notes
- 新增技术选型时，同步更新 `tech-stack.md` 与 `design-decisions.md`
- 架构变更必须更新 `architecture.md` 中的数据流图