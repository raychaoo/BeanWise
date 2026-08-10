/**
 * M6 测试基础设施：进程内 git smart-HTTP 测试服务器 + 本地裸仓辅助。
 * isomorphic-git 1.41.3 仅支持 http/https 传输（file:// 本地传输已在 1.x 移除），
 * 故单测/E2E 用进程内 HTTP 服务器暴露本地裸仓，实现最小可行 smart HTTP 协议：
 * - 仅收发全对象（无 delta）pack；fetch 恒 NAK（全量发送，客户端自动去重）；
 * - 协议细节对齐 isomorphic-git 客户端实现（GitPktLine / GitSideBand / discover 解析）。
 *
 * 独立非 test 模块（M6-T3 审查修复）：从 git-sync.test.ts 抽离，git-sync.test.ts 与
 * ipc-handlers-sync.test.ts 共用，消除「测试 import 测试」导致的用例二次收集。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { GIT_AUTHOR, SYNC_BRANCH } from './git-sync'

const SIDEBAND_MAX = 65515 // side-band-64k 单条 pkt-line 最大数据字节（1 通道字节 + 数据）
const ZERO_OID = '0000000000000000000000000000000000000000'

function pktLine(payload: string | Buffer): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = (buf.length + 4).toString(16).padStart(4, '0')
  return Buffer.concat([Buffer.from(len, 'utf8'), buf])
}
const PKT_FLUSH = Buffer.from('0000', 'utf8')

/** 从 buf 的 start 偏移读取 pkt-lines 直至 flush（含）；返回 { lines, end } */
function readPktLines(buf: Buffer, start: number): { lines: Buffer[]; end: number } {
  const lines: Buffer[] = []
  let off = start
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('utf8'), 16)
    off += 4
    if (len === 0) return { lines, end: off } // flush-pkt
    lines.push(buf.subarray(off, off + len - 4))
    off += len - 4
  }
  return { lines, end: off }
}

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag'
const OBJECT_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 }
const OBJECT_TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }

function oidOf(type: GitObjectType, content: Buffer): string {
  return createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest('hex')
}

function readLoose(gitdir: string, oid: string): { type: GitObjectType; content: Buffer } {
  const raw = inflateSync(readFileSync(join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2))))
  const nul = raw.indexOf(0)
  const [type, size] = raw.subarray(0, nul).toString('utf8').split(' ')
  const content = raw.subarray(nul + 1)
  if (content.length !== Number(size)) throw new Error(`loose object ${oid} 大小不符`)
  return { type: type as GitObjectType, content }
}

function writeLoose(gitdir: string, oid: string, type: GitObjectType, content: Buffer): void {
  const dir = join(gitdir, 'objects', oid.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, oid.slice(2)), deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`, 'utf8'), content])))
}

/** 解析 tree 内容：连续条目 <mode> <name>\0<20 字节 oid> */
function parseTreeEntries(content: Buffer): Array<{ oid: string }> {
  const entries: Array<{ oid: string }> = []
  let off = 0
  while (off < content.length) {
    const sp = content.indexOf(0x20, off) // ' '
    const nul = content.indexOf(0, sp + 1)
    entries.push({ oid: content.subarray(nul + 1, nul + 21).toString('hex') })
    off = nul + 21
  }
  return entries
}

/** 从 want oid 收集全部可达对象（commit→tree+parents；tree→子树+blob） */
function collectObjects(gitdir: string, wantOids: string[]): Map<string, { type: GitObjectType; content: Buffer }> {
  const objects = new Map<string, { type: GitObjectType; content: Buffer }>()
  const stack = [...wantOids]
  while (stack.length > 0) {
    const oid = stack.pop()!
    if (objects.has(oid) || oid === ZERO_OID) continue
    const obj = readLoose(gitdir, oid)
    objects.set(oid, obj)
    if (obj.type === 'commit') {
      const header = obj.content.toString('utf8').split('\n\n')[0] // parent/tree 只在头部区
      const tree = header.match(/^tree ([0-9a-f]{40})$/m)
      if (tree) stack.push(tree[1])
      for (const p of header.matchAll(/^parent ([0-9a-f]{40})$/gm)) stack.push(p[1])
    } else if (obj.type === 'tree') {
      for (const e of parseTreeEntries(obj.content)) stack.push(e.oid)
    }
  }
  return objects
}

/** 构建全对象 pack（v2，无 delta；结尾带 pack sha1） */
function buildPack(objects: Map<string, { type: GitObjectType; content: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  const header = Buffer.alloc(12)
  header.write('PACK', 0, 'utf8')
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(objects.size, 8)
  chunks.push(header)
  for (const { type, content } of objects.values()) {
    let size = content.length
    let byte = (OBJECT_TYPE_CODES[type] << 4) | (size & 0b1111)
    size >>>= 4
    if (size > 0) byte |= 0b10000000
    const head = [byte]
    while (size > 0) {
      byte = size & 0b01111111
      size >>>= 7
      if (size > 0) byte |= 0b10000000
      head.push(byte)
    }
    chunks.push(Buffer.from(head))
    chunks.push(deflateSync(content))
  }
  const body = Buffer.concat(chunks)
  return Buffer.concat([body, createHash('sha1').update(body).digest()])
}

/**
 * 解压从 start 开始的 zlib 流；返回内容与流长度（含终结符）。
 * 线性扫描找到流结束点：zlib 流自含终结符，第一个能解压出期望 size 字节的切片即流的精确边界
 * （stream 事件的 'end' 触发时机受内部 chunk 缓冲影响会多消费若干字节，不可依赖）。
 */
function inflateAt(data: Buffer, start: number, size: number): { content: Buffer; consumed: number } {
  for (let end = start + 1; end <= data.length; end++) {
    try {
      const content = inflateSync(data.subarray(start, end))
      if (content.length === size) return { content, consumed: end - start }
    } catch {
      // 流未完整（或尾部垃圾），继续扩展切片
    }
  }
  throw new Error(`zlib 流无法解压（期望 ${size} 字节）`)
}

/** 解析 receive-pack 请求中的全对象 pack，写入 loose objects；返回对象数 */
async function parsePackObjects(gitdir: string, buf: Buffer, start: number): Promise<number> {
  if (buf.subarray(start, start + 4).toString('utf8') !== 'PACK') throw new Error('pack 魔数不符')
  const version = buf.readUInt32BE(start + 4)
  if (version !== 2) throw new Error(`不支持的 pack 版本：${version}`)
  const count = buf.readUInt32BE(start + 8)
  let off = start + 12
  for (let i = 0; i < count; i++) {
    let byte = buf[off++]
    const type = OBJECT_TYPE_NAMES[(byte >> 4) & 0b111]
    let size = byte & 0b1111
    let shift = 4
    while (byte & 0b10000000) {
      byte = buf[off++]
      size |= (byte & 0b01111111) << shift
      shift += 7
    }
    const { content, consumed } = inflateAt(buf, off, size)
    off += consumed
    writeLoose(gitdir, oidOf(type, content), type, content)
  }
  return count
}

function listRefs(gitdir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`)
      else out.set(`${prefix}${name}`, readFileSync(p, 'utf8').trim())
    }
  }
  walk(join(gitdir, 'refs'), 'refs/')
  return out
}

function readRef(gitdir: string, ref: string): string | undefined {
  const p = join(gitdir, ref)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined
}

function writeRef(gitdir: string, ref: string, oid: string): void {
  const p = join(gitdir, ref)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${oid}\n`)
}

/** 参考发现（GET /info/refs）响应 */
function buildAdvertisement(gitdir: string, service: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH]
  const caps = service === 'git-upload-pack'
    ? ['multi_ack_detailed', 'side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main', 'agent=git/beanwise-test-server']
    : ['report-status', 'side-band-64k', 'agent=git/beanwise-test-server']
  const refs = listRefs(gitdir)
  if (refs.size === 0) {
    // 空仓用 git ≥2.41 的 no-refs 标记行而非直接 EOF：客户端对「service+flush+flush」的
    // 早退路径不返回 protocolVersion（上游 bug），listServerRefs 会误走 v2 POST 导致挂死/404
    parts.push(PKT_FLUSH)
    parts.push(pktLine(`0000000000000000000000000000000000000000 capabilities^{}\x00${caps.join(' ')}\n`))
    parts.push(PKT_FLUSH)
    return Buffer.concat(parts)
  }
  const lines: Array<{ name: string; oid: string }> = []
  const headTarget = readRef(gitdir, 'HEAD')?.startsWith('ref: ') ? readRef(gitdir, 'HEAD')!.slice(5) : undefined
  const headOid = headTarget ? refs.get(headTarget) : undefined
  if (headOid) lines.push({ name: 'HEAD', oid: headOid })
  for (const [name, oid] of refs) lines.push({ name, oid })
  lines.forEach((l, i) => {
    const capsStr = i === 0 ? `\x00${caps.join(' ')}` : ''
    parts.push(pktLine(`${l.oid} ${l.name}${capsStr}\n`))
  })
  parts.push(PKT_FLUSH)
  return Buffer.concat(parts)
}

/** upload-pack（fetch 侧）：恒 NAK + 全量 pack（side-band-64k 包裹） */
function handleUploadPack(gitdir: string, body: Buffer): Buffer {
  const { lines } = readPktLines(body, 0)
  const wants: string[] = []
  let sideband = false
  for (const line of lines) {
    const text = line.toString('utf8')
    if (text.startsWith('want ')) {
      const [oid, ...caps] = text.slice(5).trimEnd().split(' ')
      if (caps.includes('side-band-64k')) sideband = true
      wants.push(oid)
    }
    // have/done 在 flush 之后，不解析：恒 NAK 全量发送，客户端自行去重
  }
  const pack = buildPack(collectObjects(gitdir, wants))
  const parts: Buffer[] = [pktLine('NAK\n')]
  if (sideband) {
    for (let i = 0; i < pack.length; i += SIDEBAND_MAX) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + SIDEBAND_MAX)])))
    }
    parts.push(PKT_FLUSH)
  } else {
    parts.push(pack)
  }
  return Buffer.concat(parts)
}

/**
 * receive-pack（push 侧）：解析 pack → 写 loose objects → 校验并更新 refs → report-status。
 *
 * 响应格式（重要，对齐 isomorphic-git 1.41.3 客户端的实际解析管线，见 upstream issue #1722）：
 * 状态行必须经 side-band 通道 1 发送（否则落入 demux 的 packetlines 通道，而
 * parseReceivePackResponse 只读通道 1 的 packfile FIFO → ParseError "received ''"），
 * 且通道载荷必须是 pkt-line 编码（双重编码）——否则解析器把状态文本当 pkt-line 头解析，
 * parseInt('')=NaN 污染游标 → 死循环 OOM。此即该版本客户端实际能消费的唯一形状。
 */
function buildReceivePackResponse(statusLines: string[]): Buffer {
  const parts: Buffer[] = []
  for (const line of statusLines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${line}\n`)])))
  }
  parts.push(PKT_FLUSH)
  return Buffer.concat(parts)
}

/** receive-pack（push 侧）：解析 pack → 写 loose objects → 校验并更新 refs → report-status */
async function handleReceivePack(gitdir: string, body: Buffer): Promise<Buffer> {
  const { lines, end } = readPktLines(body, 0)
  const updates = lines.map((l) => {
    const text = l.toString('utf8')
    const [oldoid, newoid, refWithCaps] = text.split(' ')
    // 客户端 push 可能发短名（'main'）：落盘统一为 refs/heads/ 全名；响应回显客户端用的名字
    const rawRef = refWithCaps.split('\x00')[0]
    return { oldoid, newoid, ref: rawRef.startsWith('refs/') ? rawRef : `refs/heads/${rawRef}`, responseRef: rawRef }
  })
  await parsePackObjects(gitdir, body, body.indexOf('PACK', end))
  const refResults: string[] = []
  for (const u of updates) {
    const current = readRef(gitdir, u.ref)
    if (u.oldoid !== ZERO_OID && current !== u.oldoid) {
      refResults.push(`ng ${u.responseRef} non-fast-forward`)
    } else {
      writeRef(gitdir, u.ref, u.newoid)
      refResults.push(`ok ${u.responseRef}`)
    }
  }
  return buildReceivePackResponse(['unpack ok', ...refResults])
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** 导出供 git-sync.test.ts / ipc-handlers-sync.test.ts / E2E（M6-T5）与调试复用 */
export async function startGitServer(gitdir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method === 'GET' && u.pathname === '/info/refs') {
          const service = u.searchParams.get('service')
          if (service === 'git-upload-pack' || service === 'git-receive-pack') {
            res.writeHead(200, { 'Content-Type': `application/x-${service}-advertisement` })
            res.end(buildAdvertisement(gitdir, service))
            return
          }
        }
        if (req.method === 'POST' && (u.pathname === '/git-upload-pack' || u.pathname === '/git-receive-pack')) {
          const body = await readBody(req)
          const isUpload = u.pathname === '/git-upload-pack'
          const out = isUpload ? handleUploadPack(gitdir, body) : await handleReceivePack(gitdir, body)
          res.writeHead(200, {
            'Content-Type': isUpload ? 'application/x-git-upload-pack-result' : 'application/x-git-receive-pack-result',
          })
          res.end(out)
          return
        }
        res.writeHead(404).end()
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(e instanceof Error ? e.message : String(e))
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  return {
    // 不带尾斜杠：客户端以 `${url}/info/refs` 拼接路径，尾斜杠会产生 //info/refs 双斜杠
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

// ==================== 测试辅助 ====================

/** 本地裸仓（单测/E2E 通用 origin；零外部 git 依赖） */
export async function createBareRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'beanwise-bare-'))
  await git.init({ fs, dir, bare: true, defaultBranch: SYNC_BRANCH })
  return dir
}

/**
 * 空仓 → 初始内容（空仓不可 clone——场景 B/C 前置；content 为文件全文）。
 * clone/commit 显式 ref: main（空裸仓 clone 出的本地仓库 HEAD 停在 master——clone 内部 init 的默认分支）。
 */
export async function seedRemoteInit(remoteUrl: string, content: string): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'beanwise-seed-'))
  try {
    await git.init({ fs, dir: workDir, defaultBranch: SYNC_BRANCH })
    writeFileSync(join(workDir, 'main.beancount'), content)
    await git.add({ fs, dir: workDir, filepath: 'main.beancount' })
    await git.commit({ fs, dir: workDir, message: 'init', author: GIT_AUTHOR, ref: SYNC_BRANCH })
    await git.addRemote({ fs, dir: workDir, remote: 'origin', url: remoteUrl })
    await git.push({ fs, http, dir: workDir, remote: 'origin', ref: SYNC_BRANCH })
  } finally { rmSync(workDir, { recursive: true, force: true }) }
}

/** 非空裸仓 → 追加一笔（模拟远端他人修改；依赖已有历史） */
export async function seedRemote(remoteUrl: string, contentPatch: string): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'beanwise-seed-'))
  try {
    await git.clone({ fs, http, dir: workDir, url: remoteUrl, ref: SYNC_BRANCH, singleBranch: true })
    appendFileSync(join(workDir, 'main.beancount'), contentPatch)
    await git.add({ fs, dir: workDir, filepath: 'main.beancount' })
    await git.commit({ fs, dir: workDir, message: 'seed', author: GIT_AUTHOR, ref: SYNC_BRANCH })
    await git.push({ fs, http, dir: workDir, remote: 'origin', ref: SYNC_BRANCH })
  } finally { rmSync(workDir, { recursive: true, force: true }) }
}

/** 裸仓的 gitdir 即 dir 本身（无 .git 子目录），需显式传 gitdir；HEAD 指向 commit，须带 filepath 走树遍历 */
export async function readRemoteFile(bareDir: string): Promise<string> {
  const oid = await git.resolveRef({ fs, dir: bareDir, gitdir: bareDir, ref: 'HEAD' })
  const { blob } = await git.readBlob({ fs, dir: bareDir, gitdir: bareDir, oid, filepath: 'main.beancount' })
  return Buffer.from(blob).toString('utf8')
}
