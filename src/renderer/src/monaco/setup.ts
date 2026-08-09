/**
 * M5：Monaco worker 接线——vite `?worker` 将 worker 打成独立 chunk，
 * new Worker(本地URL) 经 worker-src 'self' 加载（生产 CSP 禁 blob/remote/unsafe-eval）。
 * 必须在任何 monaco 编辑器创建前设置：main.tsx 在 App import 之前导入本文件。
 *
 * M5-T4 实测修正（monaco-editor 0.56.0 exports map："./*" → "./esm/vs/*.js"）：
 * - "esm/vs/editor/editor.worker" 子路径经 exports 会双写前缀为 esm/vs/esm/vs/...，
 *   Node ESM / rolldown 构建 / vite dev 三处均 ERR_MODULE_NOT_FOUND；
 *   正确子路径是 "editor/editor.worker"（→ ./esm/vs/editor/editor.worker.js）。
 * - CSS 无任何 exports 子路径可映射到 .css（一律被追 .js），
 *   改经相对路径直入 node_modules（构建期内联进产物，运行时无 node_modules 依赖）。
 */
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import '../../../../node_modules/monaco-editor/min/vs/editor/editor.main.css'

;(self as unknown as { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}
