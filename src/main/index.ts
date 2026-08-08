import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
import { APP_NAME } from '../shared/app'
import { applyCsp } from './csp'
import { createDrizzle, openDatabase } from './db'
import { refreshIndex } from './index-builder'
import { registerLedgerHandlers } from './ipc-handlers'
import { PythonSvc } from './python-svc'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false // electron-vite ESM preload 需要；M3 安全评审再收紧（M1 遗留）
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

/**
 * 引擎命令解析（roadmap「Node ↔ Python」+ M2 交接说明）：
 * 开发模式调本机解释器（BEANWISE_PYTHON_CMD 可覆盖，默认 Windows py -3.11 / 其他 python3）；
 * 打包后从 extraResources 定位 resources/python/beancount-engine.exe。
 */
function resolveEngineCommand(): string[] {
  if (app.isPackaged) {
    return [join(process.resourcesPath, 'python/beancount-engine.exe'), '--stdio']
  }
  const override = process.env['BEANWISE_PYTHON_CMD']?.split(' ')
  if (override?.length) return [...override, resolve('python/service.py'), '--stdio']
  return process.platform === 'win32'
    ? ['py', '-3.11', resolve('python/service.py'), '--stdio']
    : ['python3', resolve('python/service.py'), '--stdio']
}

/** 账本路径：环境变量优先（测试/E2E 注入），默认 documents/beanwise/main.beancount */
function resolveLedgerPath(): string {
  return process.env['BEANWISE_LEDGER_PATH'] ?? join(app.getPath('documents'), 'beanwise', 'main.beancount')
}

let pythonSvc: PythonSvc | null = null
let quitHandled = false

app.whenReady().then(() => {
  applyCsp(app.isPackaged)

  pythonSvc = new PythonSvc({ command: resolveEngineCommand() })
  const db = createDrizzle(openDatabase(join(app.getPath('userData'), 'beanwise.db')))
  registerLedgerHandlers(ipcMain, { db, engine: pythonSvc, ledgerPath: resolveLedgerPath() })

  // 启动初始刷新（fire-and-forget：失败不影响窗口创建，状态由 ledger:status 暴露）
  void pythonSvc
    .start()
    .then(() => refreshIndex(db, pythonSvc!, resolveLedgerPath()))
    .catch((err: unknown) => {
      console.error('[BeanWise] 初始索引刷新失败:', err)
    })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 平台仅 Windows（2026-08 定稿）：所有窗口关闭即退出
app.on('window-all-closed', () => {
  app.quit()
})

// before-quit 优雅关闭：shutdown RPC → 进程退出 0；二次触发直接放行
app.on('before-quit', (event) => {
  if (quitHandled) return
  quitHandled = true
  event.preventDefault()
  void (async () => {
    if (pythonSvc) await pythonSvc.stop()
    app.quit()
  })()
})
