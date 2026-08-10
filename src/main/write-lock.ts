/**
 * M5 双写互斥抽取：add-entry / save-file / sync 全部经同一把锁串行化
 * （任一时刻至多一个文件写者，防保存管线交错覆盖，见 ipc-handlers.ts M5 终审注释）。
 */
let writeQueue: Promise<unknown> = Promise.resolve()
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn)
  writeQueue = next.catch(() => {})
  return next
}
