/**
 * git 同步的「追踪文件集」单一事实源（main / renderer 共用，ADR 28）。
 *
 * 同步范围 = 账本 + 账户库 + Excel 导入模板 + 受托管 .gitignore。
 * 明确排除（写进 .gitignore，永不提交）：
 * - `.beanwise/index.db`（含 WAL 三件套）：可从 main.beancount 重建的索引缓存，二进制、高频变动；
 * - `.beanwise/sync-config.json`：含 lastSyncAt（每次同步都变，会造成提交噪声）与 lastError，
 *   且新机器 clone 后会出现「显示已配置但本机无 PAT」的错位——PAT 只经 safeStorage 存 electron-store，
 *   从不进仓库。新机器需重新填写仓库地址 + PAT（有意设计）。
 */
import type { SyncFileConflict } from './ipc'

export const SYNC_LEDGER_FILE = 'main.beancount'
export const SYNC_ACCOUNTS_FILE = '.beanwise/accounts.json'
export const SYNC_TEMPLATES_FILE = '.beanwise/excel-import-templates.json'
export const SYNC_GITIGNORE_FILE = '.gitignore'

/**
 * 提交与三路合并的文件集。`.gitignore` 一并追踪：忽略规则随仓库传播到新机器，
 * 否则新机器 clone 后 `.beanwise/index.db` 又变成未跟踪噪声。
 */
export const SYNC_TRACKED_FILES: readonly string[] = [
  SYNC_LEDGER_FILE,
  SYNC_ACCOUNTS_FILE,
  SYNC_TEMPLATES_FILE,
  SYNC_GITIGNORE_FILE
]

/**
 * 「本地是否已有内容」判据（场景 B 是否 clone 用）。
 * 不含 `.gitignore`——用户为别的用途写了 .gitignore 不应改变首同步场景。
 */
export const SYNC_CONTENT_FILES: readonly string[] = [
  SYNC_LEDGER_FILE,
  SYNC_ACCOUNTS_FILE,
  SYNC_TEMPLATES_FILE
]

/** 受托管块 marker（幂等补写的锚点；`ensureGitignore` 只追加/创建，永不覆写用户已有规则） */
export const SYNC_GITIGNORE_BEGIN = '# >>> BeanWise 同步托管块（请勿手改，随同步更新）>>>'
export const SYNC_GITIGNORE_END = '# <<< BeanWise 同步托管块 <<<'

/** 托管块内容（`ensureGitignore` 落盘用） */
export const SYNC_GITIGNORE_BLOCK = [
  SYNC_GITIGNORE_BEGIN,
  '# 索引缓存（可从 main.beancount 重建；better-sqlite3 用 WAL，三件套一并忽略）',
  '.beanwise/index.db',
  '.beanwise/index.db-wal',
  '.beanwise/index.db-shm',
  '# 本机同步元数据（lastSyncAt 每次同步都变；PAT 不落工作区）',
  '.beanwise/sync-config.json',
  '.beanwise/*.tmp',
  '# writeLedgerChecked 的临时文件落在工作区根（不在 .beanwise/ 内）',
  '*.beancount.tmp',
  SYNC_GITIGNORE_END
].join('\n')

/** 冲突文件的中文标签（ConflictView tab / Alert 文案） */
export function syncFileLabel(path: string): string {
  switch (path) {
    case SYNC_LEDGER_FILE: return '账本'
    case SYNC_ACCOUNTS_FILE: return '账户库'
    case SYNC_TEMPLATES_FILE: return 'Excel 导入模板'
    case SYNC_GITIGNORE_FILE: return '.gitignore'
    default: return path
  }
}

/** 该文件是否按 JSON 结构化合并（否则按文本三路 diff3） */
export function isJsonSyncFile(path: string): boolean {
  return path === SYNC_ACCOUNTS_FILE || path === SYNC_TEMPLATES_FILE
}

/** 冲突快照 → 渲染端可读的简述（「账本、账户库」） */
export function describeConflicts(conflicts: SyncFileConflict[]): string {
  return conflicts.map((c) => syncFileLabel(c.path)).join('、')
}
