/**
 * save 管线两阶段落盘的 tmp 生命周期（M14 补测）。
 *
 * 为什么单独成文件：`stageLedgerChecked` 此前没有直接单测，只被 IPC 层间接覆盖，
 * 而「引擎 throw 时 tmp 是否清掉」这条恰好落在间接覆盖的缝隙里——实测漏了（2.4MB 的
 * main.beancount.tmp 在真实账本目录躺了两天）。三条用例把 tmp 的三种归宿钉死。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PythonSvc } from '../core/python-svc'
import { commitStagedLedger, stageLedgerChecked, writeLedgerChecked } from './ledger-writer'

let dir: string
let ledgerPath: string

/** 只用到 parseEntries 的假引擎；其余成员靠断言兜底（真 PythonSvc 需要真实 spawn） */
function fakeEngine(parseEntries: (filename: string) => Promise<{ errors: Array<{ message: string }> }>): PythonSvc {
  return { parseEntries } as unknown as PythonSvc
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'beanwise-lw-'))
  ledgerPath = join(dir, 'main.beancount')
  writeFileSync(ledgerPath, '2026-01-01 open Assets:Bank:ZSYH CNY\n', 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('stageLedgerChecked 的 tmp 生命周期（M14）', () => {
  it('校验通过：tmp 留存待 commit，原文件不动', async () => {
    const deps = { ledgerPath, engine: fakeEngine(async () => ({ errors: [] })) }
    await expect(stageLedgerChecked(deps, '新内容\n')).resolves.toEqual({ ok: true })

    expect(readFileSync(`${ledgerPath}.tmp`, 'utf8')).toBe('新内容\n')
    expect(readFileSync(ledgerPath, 'utf8')).toBe('2026-01-01 open Assets:Bank:ZSYH CNY\n')

    commitStagedLedger(ledgerPath)
    expect(readFileSync(ledgerPath, 'utf8')).toBe('新内容\n')
    expect(existsSync(`${ledgerPath}.tmp`)).toBe(false)
  })

  it('校验失败（errors 非空）：删 tmp、原文件不动、返回错误文案', async () => {
    const deps = {
      ledgerPath,
      engine: fakeEngine(async () => ({ errors: [{ message: '语法错误' }, { message: '账户不合法' }] }))
    }
    const result = await stageLedgerChecked(deps, '坏内容\n')

    expect(result).toEqual({ ok: false, message: '语法错误; 账户不合法' })
    expect(existsSync(`${ledgerPath}.tmp`)).toBe(false)
    expect(readFileSync(ledgerPath, 'utf8')).toBe('2026-01-01 open Assets:Bank:ZSYH CNY\n')
  })

  it('引擎 throw（ENOENT / -32601 / 超时）：删 tmp 且异常冒泡', async () => {
    const deps = {
      ledgerPath,
      engine: fakeEngine(async () => {
        throw new Error('RPC 错误 -32601: 未知方法: parse_entries')
      })
    }

    await expect(stageLedgerChecked(deps, '新内容\n')).rejects.toThrow(/-32601/)
    // 关键断言：throw 路径也必须清 tmp，否则残留会一直留在账本目录
    expect(existsSync(`${ledgerPath}.tmp`)).toBe(false)
    expect(readFileSync(ledgerPath, 'utf8')).toBe('2026-01-01 open Assets:Bank:ZSYH CNY\n')
  })
})

describe('writeLedgerChecked（stage + commit 组合）', () => {
  it('校验通过才落盘，且不残留 tmp', async () => {
    const deps = { ledgerPath, engine: fakeEngine(async () => ({ errors: [] })) }
    await expect(writeLedgerChecked(deps, '新内容\n')).resolves.toEqual({ ok: true })

    expect(readFileSync(ledgerPath, 'utf8')).toBe('新内容\n')
    expect(existsSync(`${ledgerPath}.tmp`)).toBe(false)
  })

  it('校验失败不落盘', async () => {
    const deps = { ledgerPath, engine: fakeEngine(async () => ({ errors: [{ message: '语法错误' }] })) }
    await expect(writeLedgerChecked(deps, '坏内容\n')).resolves.toEqual({ ok: false, message: '语法错误' })

    expect(readFileSync(ledgerPath, 'utf8')).toBe('2026-01-01 open Assets:Bank:ZSYH CNY\n')
    expect(existsSync(`${ledgerPath}.tmp`)).toBe(false)
  })
})
