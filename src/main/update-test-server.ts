/**
 * M8 测试基础设施：进程内 electron-updater generic 更新源 mock（零网络零发布成本）。
 * 与 git-test-server / ai-test-server 同策略：独立非 test 模块，E2E 共用单一实现。
 * latest.yml 同时声明 .exe（Windows/NsisUpdater）与 .AppImage（CI ubuntu/AppImageUpdater）
 * 两条文件——断言状态流转与平台无关；sha512 = 服务内容字节的 base64 摘要（updater 会校验）。
 * 文件端点加 2s 下载延迟（模拟真实网络）：E2E 需在「发现新版本（available）」态停留的窗口内
 * 完成断言——本地 mock 秒级下载会让 available 态转瞬即逝（M8-T7 实测修正，见报告）。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ServerResponse } from 'node:http'

export const MOCK_VERSION = '9.9.9'
/** 文件响应延迟（ms）：给 E2E 状态断言留窗口（本地网络下载太快，available 态不可观测） */
const FILE_DELAY_MS = 2000
const EXE_NAME = 'BeanWise-Setup-9.9.9.exe'
const APPIMAGE_NAME = 'BeanWise-9.9.9.AppImage'

const EXE_BYTES = Buffer.alloc(1024, 0x5a) // 确定性假安装包字节
const APPIMAGE_BYTES = Buffer.alloc(2048, 0x41)

function b64sha512(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

/** latest.yml（electron-builder generic provider 元数据格式） */
function latestYml(): string {
  const exe = `  - url: ${EXE_NAME}\n    sha512: ${b64sha512(EXE_BYTES)}\n    size: ${EXE_BYTES.length}`
  const appimage = `  - url: ${APPIMAGE_NAME}\n    sha512: ${b64sha512(APPIMAGE_BYTES)}\n    size: ${APPIMAGE_BYTES.length}`
  return `version: ${MOCK_VERSION}\nfiles:\n${exe}\n${appimage}\npath: ${EXE_NAME}\nsha512: ${b64sha512(EXE_BYTES)}\nreleaseDate: '2026-08-11T00:00:00.000Z'\n`
}

export interface UpdateServer {
  url: string
  close(): Promise<void>
}

/** 延迟响应文件体（模拟真实下载耗时；头部先行，字节不变——sha512 校验不受影响） */
function serveFile(res: ServerResponse, bytes: Buffer): void {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) })
  setTimeout(() => res.end(bytes), FILE_DELAY_MS)
}

export async function startUpdateServer(): Promise<UpdateServer> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/latest.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' })
      res.end(latestYml())
      return
    }
    if (path === `/${EXE_NAME}`) {
      serveFile(res, EXE_BYTES)
      return
    }
    if (path === `/${APPIMAGE_NAME}`) {
      serveFile(res, APPIMAGE_BYTES)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}
