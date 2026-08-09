/**
 * M5：Monaco worker 接线——vite `?worker` 将 worker 打成独立 chunk，
 * new Worker(本地URL) 经 worker-src 'self' 加载（生产 CSP 禁 blob/remote/unsafe-eval）。
 * 必须在任何 monaco 编辑器创建前设置：main.tsx 在 App import 之前导入本文件。
 */
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import 'monaco-editor/min/vs/editor/editor.main.css'

;(self as unknown as { MonacoEnvironment: { getWorker(): Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}
