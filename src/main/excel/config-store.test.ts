import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExcelImportTemplate } from '../../shared/ipc'
import { defaultAccountMapping } from './account-mapping'
import { JsonExcelTemplateStore } from './config-store'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const TEMPLATE: ExcelImportTemplate = {
  id: 't1',
  name: '招商银行信用卡',
  source: 'cmb-credit',
  fieldMapping: { dateColumn: '交易时间', amountColumn: '金额', ioColumn: '收/支' },
  directionRule: { mode: 'column' },
  accountMapping: defaultAccountMapping(),
  strictNewAccounts: true
}

describe('JsonExcelTemplateStore', () => {
  it('未配置返回空列表；保存后可读回；覆盖同 id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beanwise-excel-config-'))
    dirs.push(dir)
    const store = new JsonExcelTemplateStore(join(dir, '.beanwise', 'excel-import-templates.json'))
    expect(store.load()).toEqual([])

    store.save([TEMPLATE])
    expect(store.load()).toEqual([TEMPLATE])

    const renamed = { ...TEMPLATE, name: '招商信用卡' }
    store.save([renamed])
    expect(store.load()).toEqual([renamed])
  })

  it('损坏 JSON 回退空列表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beanwise-excel-config-'))
    dirs.push(dir)
    const file = join(dir, '.beanwise', 'excel-import-templates.json')
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(join(dir, '.beanwise'), { recursive: true })
    writeFileSync(file, '{bad', 'utf8')
    expect(new JsonExcelTemplateStore(file).load()).toEqual([])
  })
})
