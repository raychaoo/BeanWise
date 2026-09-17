/**
 * 工作目录的存储键：Windows 盘符大小写与路径分隔符不应影响同一个目录的标识。
 *
 * 单独一个模块（**不 import electron**）是为了可单测，也因为 PAT（stores/token-store）与
 * M13 的 GitHub 识别缓存（stores/git-identity-store）**必须同域**：两者都用工作目录做键，
 * 一旦分叉就会「用 A 目录的 PAT 识别出的身份挂到 B 目录的提交上」。共用同一个实现是把这条
 * 不变式做成结构性的，而不是靠注释。
 */
import { resolve } from 'node:path'

export function workspaceStorageKey(workspaceDir: string): string {
  return resolve(workspaceDir).toLowerCase()
}
