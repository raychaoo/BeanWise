/**
 * M6 E2E 裸仓工具（薄 re-export，M6-T7）。
 *
 * brief 原案为本地 file:// 仓库模拟 GitHub origin（pathToFileURL），但 isomorphic-git 1.41.3
 * 已移除 file:// 本地传输（M6-T1 实测）——E2E 裸仓一律经进程内 smart-HTTP 服务器
 * （src/main/git-test-server.ts，T1/T3 已建立，单测/E2E 共用单一实现，避免两套 helper 漂移）。
 *
 * 用法：`const bareDir = await createBareRepo()` → `const server = await startGitServer(bareDir)`
 * → 配置 URL 用 `server.url`（http://127.0.0.1:<port>，validateConfigureParams 已放行回环 HTTP）；
 * 空仓初始内容用 seedRemoteInit(server.url, content)，追加远端提交用 seedRemote(server.url, patch)，
 * 验证用 readRemoteFile(bareDir)；afterAll 关闭 server 并 rmSync 裸仓目录。
 */
export { createBareRepo, readRemoteFile, seedRemote, seedRemoteInit, startGitServer } from '../../src/main/git-test-server'
