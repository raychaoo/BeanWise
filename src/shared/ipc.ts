/**
 * IPC 通道契约（唯一来源）。命名规范：{domain}:{action} 小写 kebab，
 * 见 technical-proposal/implementation-roadmap.md「IPC 契约」。
 * 具体业务通道由 M3（IPC 骨架 + SQLite 索引）定义。
 */
export type IpcChannel = `${string}:${string}`
