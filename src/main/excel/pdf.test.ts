import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readPdfGrid } from './pdf'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe('readPdfGrid（招商银行版式）', () => {
  it('抽取表头与全部数据行，跳过元信息/重复表头/页码/提示块，换行对手信息归并', async () => {
    const grid = await readPdfGrid(fixture('cmb-sample.pdf'))
    expect(grid[0]).toEqual(['记账日期', '货币', '交易金额', '联机余额', '交易摘要', '对手信息'])
    expect(grid.length - 1).toBe(10)
    expect(grid[1]).toEqual(['2022-09-12', 'CNY', '1.23', '1.23', '银联代付', '财付通支付科技有限公司'])

    const joined = grid.map((r) => r.join('|')).join('\n')
    expect(joined).not.toContain('户名') // 页首元信息被跳过
    expect(joined).not.toContain('账号')
    expect(joined).not.toContain('1/3') // 页码被跳过
    expect(joined).not.toContain('温馨提示') // 页尾提示块被跳过

    // 换行对手信息：深圳金拱门食品有限 + 公司 → 合并到同一行
    const wrapped = grid.find((r) => r[0] === '2022-10-18')
    expect(wrapped?.[5]).toBe('深圳金拱门食品有限公司')

    // 英文副表头（Transaction/Amount）不得拼入金额列
    expect(joined).not.toContain('Transaction')
    expect(joined).not.toContain('Amount')
    for (const r of grid.slice(1)) {
      expect(r[2]).toMatch(/^-?\d[\d,]*\.\d{2}$/)
    }

    // 末行干净（无分隔线/提示块拼接）
    const last = grid[grid.length - 1]
    expect(last[0]).toBe('2022-10-24')
    expect(last[5]).toBe('深圳妙创信息技术有限公司')
  })
})

describe('readPdfGrid（交通银行版式）', () => {
  it('识别 11 列表头、按日期列分行、归并换行、跳过页尾汇总块', async () => {
    const grid = await readPdfGrid(fixture('bocom-sample.pdf'))
    expect(grid[0]).toEqual([
      '序号', '交易日期', '交易时间', '交易类型', '借贷状态', '交易金额',
      '余额', '对方账号', '对方户名', '交易地点', '摘要'
    ])
    expect(grid.length - 1).toBe(5)
    expect(grid[1]).toMatchObject({
      0: '1', 1: '2020-08-11', 4: 'C', 5: '2889.66',
      7: '44244218601880000855', 8: '国粤(韶关)电力有限公司'
    })
    // 换行对方户名归并到同一行
    expect(grid[2]?.[8]).toBe('支付宝（中国）网络技术有限公司')
    const joined = grid.map((r) => r.join('|')).join('\n')
    expect(joined).not.toContain('打印完毕')
    expect(joined).not.toContain('汇总')
    for (const r of grid.slice(1)) {
      expect(r[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r[5]).toMatch(/^-?\d[\d,]*\.\d{2}$/)
    }
  })
})

describe('readPdfGrid（无法识别）', () => {
  it('纯文本无表格 PDF 抛中文错误（扫描件提示）', async () => {
    await expect(readPdfGrid(fixture('plain.pdf'))).rejects.toThrow(/未能从 PDF 中识别流水表格/)
  })
})
