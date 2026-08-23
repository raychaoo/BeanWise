/**
 * 银行流水 PDF 抽取（M10，通用版式）：按「列位置 + 行分组」把文字版对账单还原成网格。
 *
 * 已验证版式：
 * - 招商银行：表头 记账日期|货币|交易金额|联机余额|交易摘要|对手信息，每页重复表头 + 页脚页码；
 * - 交通银行：表头 序号|交易日期|交易时间|交易类型|借贷状态|交易金额|余额|对方账号|对方户名|交易地点|摘要，
 *   记录跨多行（对方/摘要换行），换行片段按「最近的主行」归并，页尾有「打印完毕/汇总」。
 *
 * 通用识别：
 * - 表头行 = 含 ≥3 个列名关键词、且同时含「日期」与「金额」的行（中文表头）；
 * - 日期列 = 表头名含「日期」的列；数据行 = 日期列匹配 YYYY-MM-DD；
 * - 跳过：表头上方元信息、重复表头、英文副表头（首行数据前的纯英文行）、页脚页码、
 *   页尾提示/汇总块（温馨提示/验真/打印完毕/汇总/分隔线/星号线）。
 *
 * 抽取结果 = [表头行, ...数据行]，与 xlsx/csv 走同一套列映射 / 方向判定 / 去重管线。
 */
import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PAGE_NO_RE = /^\d+\/\d+$/
const MAX_ROWS = 50_000
const LINE_TOLERANCE = 1.5
const ENGLISH_RE = /^[A-Za-z ]+$/

/** 表头列名关键词（中文表头行命中数最高） */
const HEADER_KEYWORDS = ['日期', '金额', '摘要', '交易类型', '余额', '对方', '借贷', '序号', '时间', '货币', '状态']
/** 页尾终止块（命中任一单元格即结束本页） */
const TERMINATE_RES: RegExp[] = [
  /温馨提示|验真/,
  /打印完毕/,
  /汇总|发生额/,
  /^[\s*]+$/,
  /^[—\-–\s=]{4,}$/
]

interface PdfItem {
  x: number
  y: number
  text: string
}

interface PdfLine {
  y: number
  texts: PdfItem[]
}

function groupLines(items: PdfItem[]): PdfLine[] {
  const lines: PdfLine[] = []
  for (const item of items) {
    const line = lines.find((l) => Math.abs(l.y - item.y) <= LINE_TOLERANCE)
    if (line) line.texts.push(item)
    else lines.push({ y: item.y, texts: [item] })
  }
  return lines
}

/** 列边界 = 相邻表头列起点中点；最后一列无上界。 */
function buildBounds(starts: number[]): number[] {
  const bounds: number[] = []
  for (let i = 0; i < starts.length - 1; i++) bounds.push((starts[i] + starts[i + 1]) / 2)
  return bounds
}

/** 按列边界把一行文本分列，列内按 x 排序后拼接（中文单元格直接拼接）。 */
function assignCells(texts: PdfItem[], bounds: number[], colCount: number): string[] {
  const cols: PdfItem[][] = Array.from({ length: colCount }, () => [])
  for (const t of texts) {
    let col = 0
    while (col < bounds.length && t.x >= bounds[col]) col++
    cols[col].push(t)
  }
  return cols.map((arr) => arr.sort((a, b) => a.x - b.x).map((t) => t.text).join(''))
}

/** 表头行命中分：含列名关键词的单元格数。 */
function headerScore(cells: string[]): number {
  let score = 0
  for (const cell of cells) {
    if (HEADER_KEYWORDS.some((kw) => cell.includes(kw))) score++
  }
  return score
}

function nearestRowIndex(y: number, starts: number[]): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < starts.length; i++) {
    const d = Math.abs(y - starts[i])
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

/** 读取文字版银行流水 PDF → 网格（首行为表头）。 */
export async function readPdfGrid(filePath: string): Promise<string[][]> {
  const data = new Uint8Array(readFileSync(filePath))
  const task = getDocument({ data, useSystemFonts: true })
  const doc = await task.promise
  try {
    let headerNames: string[] = []
    let headerStarts: number[] = []
    let dateCol = -1
    let firstHeaderY = 0
    const gridRows: string[][] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      const items: PdfItem[] = []
      for (const raw of tc.items) {
        const it = raw as { str?: string; transform?: number[] }
        const text = (it.str ?? '').trim()
        if (!text) continue
        const t = it.transform ?? []
        items.push({ x: t[4] ?? 0, y: t[5] ?? 0, text })
      }
      const lines = groupLines(items).sort((a, b) => b.y - a.y) // 自上而下：y 递减

      // 每页找中文表头行（元信息/英文副表头得分低）
      let headerY = firstHeaderY
      let best: PdfLine | null = null
      let bestScore = 0
      for (const line of lines) {
        const cells = line.texts.slice().sort((a, b) => a.x - b.x).map((t) => t.text)
        const score = headerScore(cells)
        if (score > bestScore && score >= 3 && cells.some((c) => c.includes('日期')) && cells.some((c) => c.includes('金额'))) {
          best = line
          bestScore = score
        }
      }
      if (best) {
        const headerCells = best.texts.slice().sort((a, b) => a.x - b.x)
        if (headerNames.length === 0) {
          headerNames = headerCells.map((c) => c.text)
          headerStarts = headerCells.map((c) => c.x)
          dateCol = headerNames.findIndex((n) => n.includes('日期'))
        }
        headerY = best.y
        firstHeaderY = headerY
      }
      if (headerNames.length === 0) continue

      const bounds = buildBounds(headerStarts)
      const kept: { cells: string[]; y: number; rowStart: boolean }[] = []
      let sawData = false
      let terminated = false
      for (const line of lines) {
        if (line.y > headerY + LINE_TOLERANCE) continue // 表头上方元信息
        const cells = assignCells(line.texts, bounds, headerNames.length)
        const dateCell = cells[dateCol] ?? ''
        if (dateCell === headerNames[dateCol] || dateCell === 'Date') continue // 重复表头 / 英文副表头（日期列）
        if (cells.some((c) => PAGE_NO_RE.test(c))) continue // 页脚页码
        if (cells.some((c) => TERMINATE_RES.some((re) => re.test(c)))) {
          terminated = true
          break // 页尾提示/汇总块，本页结束
        }
        // 首行数据前的纯英文行 = 英文副表头
        if (!sawData && cells.every((c) => c === '' || ENGLISH_RE.test(c))) continue
        const rowStart = DATE_RE.test(dateCell)
        if (rowStart) sawData = true
        kept.push({ cells, y: line.y, rowStart })
      }

      // 非主行片段归并到「最近的」主行（换行片段可能在主行上方或下方）
      const starts = kept.filter((k) => k.rowStart).map((k) => k.y)
      const rows = kept.filter((k) => k.rowStart).map((k) => k.cells.slice())
      for (const k of kept) {
        if (k.rowStart) continue
        if (starts.length === 0) continue
        const idx = nearestRowIndex(k.y, starts)
        const target = rows[idx]
        for (let i = 0; i < k.cells.length; i++) {
          if (k.cells[i]) target[i] = target[i] ? target[i] + k.cells[i] : k.cells[i]
        }
      }
      for (const r of rows) {
        if (gridRows.length >= MAX_ROWS) break
        gridRows.push(r)
      }
      if (terminated && gridRows.length >= MAX_ROWS) break
    }
    if (headerNames.length === 0 || gridRows.length === 0) {
      throw new Error('未能从 PDF 中识别流水表格（可能为扫描件，请先转成 xlsx/csv）')
    }
    return [headerNames, ...gridRows]
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
