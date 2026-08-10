/**
 * diff3（Tony Garnock-Jones / LShift 的 diff3 合并算法，MIT）类型声明。
 * 包本身无 d.ts（v0.0.4，CommonJS）；isomorphic-git 1.x 内置同款算法作为其 mergeFile/mergeDriver。
 */
declare module 'diff3' {
  export interface Diff3Ok {
    ok: string[]
  }
  export interface Diff3Conflict {
    conflict: {
      a: string[]
      o: string[]
      b: string[]
    }
  }
  export type Diff3Item = Diff3Ok | Diff3Conflict
  /** @param a ours 行数组，@param o base 行数组，@param b theirs 行数组 */
  export default function diff3Merge(a: string[], o: string[], b: string[]): Diff3Item[]
}
