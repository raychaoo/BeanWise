import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import electronUpdater from 'electron-updater' // CJS（autoUpdater 为 getter 重导出，ESM 命名导入会 SyntaxError）
import { APP_NAME } from '../shared/app'
import { UPDATE_STATUS_CHANNEL, type UpdateState } from '../shared/ipc'
import { applyCsp } from './core/csp'
import { createDrizzle, openDatabase } from './db'
import { GitSync } from './core/git-sync'
import { refreshIndex } from './core/index-builder'
import { registerAiHandlers } from './ipc/ai/ipc-handlers-ai'
import { registerLedgerHandlers } from './ipc/ledger/ipc-handlers'
import { registerReportHandlers } from './ipc/report/ipc-handlers-report'
import { registerSyncHandlers } from './ipc/sync/ipc-handlers-sync'
import { registerUpdateHandlers } from './ipc/update/ipc-handlers-update'
import { LEDGER_FILE, registerWorkspaceHandlers } from './ipc/workspace/ipc-handlers-workspace'
import { PythonSvc } from './core/python-svc'
import { JsonAccountConfigStore } from './stores/account-config-store'
import { registerAccountHandlers } from './ipc/accounts/ipc-handlers-accounts'
import { registerExcelHandlers } from './ipc/excel/ipc-handlers-excel'
import { JsonExcelTemplateStore } from './excel/config-store'
import { ElectronAiTokenStore, ElectronWorkspaceTokenStore } from './stores/token-store'
import type { SyncConfigStore, TokenStore } from './stores/token-store'
import { createUpdaterService } from './stores/updater'
import { ElectronWorkspaceStore } from './stores/workspace-store'
import { JsonSyncConfigStore } from './stores/workspace-config-store'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    useContentSize: true,
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

/**
 * 动态运行时。工作目录切换时重建 db / gitSync / ledgerPath，
 * 已注册的 handler 通过 getter 始终读到最新值。
 */
interface Runtime {
  db: ReturnType<typeof createDrizzle> | null
  ledgerPath: string | null
  gitSync: GitSync | null
  database: ReturnType<typeof openDatabase> | null
  syncTokens: TokenStore | null
  syncConfig: SyncConfigStore | null
  accountConfig: JsonAccountConfigStore | null
  excelTemplates: JsonExcelTemplateStore | null
}

const runtime: Runtime = {
  db: null,
  ledgerPath: null,
  gitSync: null,
  database: null,
  syncTokens: null,
  syncConfig: null,
  accountConfig: null,
  excelTemplates: null
}

let pythonSvc: PythonSvc | null = null
let quitHandled = false
let workspaceStore: ElectronWorkspaceStore | null = null

/** 往来类账户路径（ADR 23）：读账户库 counterparty 标志，**调用时实时取值**
 * （账户库可先于账本变化，注册时快照会读到旧值）。录入挂链与往来账报表共用此源。 */
function counterpartyAccounts(): string[] {
  return (runtime.accountConfig?.load() ?? []).filter((a) => a.counterparty === true).map((a) => a.value)
}

/** 为指定工作目录创建运行时组件并刷新索引；旧 db 先关闭防泄漏 */
function activateWorkspace(workspaceDir: string): void {
  // 关闭旧数据库连接
  if (runtime.database) {
    try { runtime.database.close() } catch { /* already closed */ }
    runtime.db = null
    runtime.database = null
  }

  const ledgerPath = join(workspaceDir, LEDGER_FILE)
  const dbDir = join(workspaceDir, '.beanwise')
  mkdirSync(dbDir, { recursive: true })
  runtime.syncTokens = new ElectronWorkspaceTokenStore(workspaceDir)
  runtime.syncConfig = new JsonSyncConfigStore(join(dbDir, 'sync-config.json'))
  runtime.accountConfig = new JsonAccountConfigStore(join(dbDir, 'accounts.json'))
  runtime.excelTemplates = new JsonExcelTemplateStore(join(dbDir, 'excel-import-templates.json'))

  runtime.database = openDatabase(join(dbDir, 'index.db'))
  runtime.db = createDrizzle(runtime.database)
  runtime.ledgerPath = ledgerPath
  runtime.gitSync = new GitSync({
    ledgerPath,
    auth: () => ({ username: 'x-access-token', password: runtime.syncTokens?.load() ?? '' })
  })

  // 刷新索引（fire-and-forget）
  if (pythonSvc && runtime.db) {
    void refreshIndex(runtime.db, pythonSvc, ledgerPath).catch((err: unknown) => {
      console.error('[BeanWise] 工作目录索引刷新失败:', err)
    })
  }
}

app.whenReady().then(() => {
  applyCsp(app.isPackaged)

  pythonSvc = new PythonSvc({ command: resolveEngineCommand() })
  workspaceStore = new ElectronWorkspaceStore()

  // 工作目录域四通道（choose/open/get-status；open 内部触发 activateWorkspace）
  registerWorkspaceHandlers(ipcMain, {
    store: workspaceStore,
    showFolderDialog: async () => {
      const win = BrowserWindow.getAllWindows()[0]
      return win
        ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
        : { canceled: true, filePaths: [] }
    },
    onWorkspaceChanged: (path: string) => activateWorkspace(path),
    getGit: () => runtime.gitSync
  })

  // 恢复上次的工作目录（存在才激活；不存在则渲染端显示选择界面）
  const savedWorkspace = workspaceStore.loadCurrent()
  if (savedWorkspace && existsSync(savedWorkspace)) {
    activateWorkspace(savedWorkspace)
  }

  // ledger 域七通道（deps 用 getter 读运行时值——工作目录切换后自动指向新路径/新库）
  registerLedgerHandlers(ipcMain, {
    get engine() { return pythonSvc! },
    get db() { return runtime.db! },
    get ledgerPath() { return runtime.ledgerPath ?? '' },
    // ADR 23 P2：录入时自动盖/挂贷款 link
    counterpartyAccounts
  })

  // 通用账户库（跟随工作目录）
  registerAccountHandlers(ipcMain, {
    get store() { return runtime.accountConfig! }
  })

  // M10：通用 Excel 流水导入（工作目录模板 + 文件选择框）
  registerExcelHandlers(ipcMain, {
    get db() { return runtime.db! },
    get engine() { return pythonSvc! },
    get ledgerPath() { return runtime.ledgerPath ?? '' },
    get templates() { return runtime.excelTemplates! },
    get accountConfig() { return runtime.accountConfig! },
    showFileDialog: async () => {
      const win = BrowserWindow.getAllWindows()[0]
      return win
        ? dialog.showOpenDialog(win, {
            properties: ['openFile'],
            filters: [
              { name: 'Excel/CSV/PDF 流水', extensions: ['xlsx', 'xls', 'csv', 'pdf'] },
              { name: 'Excel 工作簿', extensions: ['xlsx'] },
              { name: 'CSV', extensions: ['csv'] }
            ]
          })
        : { canceled: true, filePaths: [] }
    }
  })

  // sync 域六通道
  registerSyncHandlers(ipcMain, {
    get engine() { return pythonSvc! },
    get db() { return runtime.db! },
    get ledgerPath() { return runtime.ledgerPath ?? '' },
    tokens: {
      load: () => runtime.syncTokens?.load() ?? null,
      save: (pat) => {
        if (!runtime.syncTokens) throw new Error('内部错误：工作目录未就绪')
        runtime.syncTokens.save(pat)
      },
      clear: () => runtime.syncTokens?.clear()
    },
    config: {
      load: () => runtime.syncConfig?.load() ?? null,
      save: (config) => {
        if (!runtime.syncConfig) throw new Error('内部错误：工作目录未就绪')
        runtime.syncConfig.save(config)
      },
      clear: () => runtime.syncConfig?.clear()
    },
    get git() { return runtime.gitSync! }
  })

  // M7：ai 域四通道。DeepSeek Key 独立 store（ai-tokens，safeStorage 加密）；
  // BEANWISE_AI_BASE_URL 为测试/E2E 注入 mock 端点（默认官方端点，CSP 零改动——fetch 在主进程）
  const aiTokens = new ElectronAiTokenStore()
  registerAiHandlers(ipcMain, {
    get db() { return runtime.db! },
    tokens: aiTokens,
    baseUrl: process.env['BEANWISE_AI_BASE_URL']
  })

  // M8：update 域三通道。autoUpdater 注入（状态机封装）；BEANWISE_UPDATE_FEED_URL
  // 为测试/E2E 注入 mock 更新源（setFeedURL + forceDevUpdateConfig）；生产走 app-update.yml
  const updater = createUpdaterService({
    updater: electronUpdater.autoUpdater,
    currentVersion: app.getVersion(),
    feedUrl: process.env['BEANWISE_UPDATE_FEED_URL']
  })
  registerUpdateHandlers(ipcMain, {
    updater,
    broadcast: (s: UpdateState) => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(UPDATE_STATUS_CHANNEL, s))
    }
  })

  // M8：report 域通道（报表只读聚合，复用 M3 索引）+ 批次 G PDF 导出（printToPDF + 保存对话框）
  registerReportHandlers(ipcMain, {
    get db() { return runtime.db! },
    getWindow: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    showSaveDialog: (options) => dialog.showSaveDialog(options),
    writeFile: (filePath, data) => writeFile(filePath, data),
    counterpartyAccounts
  })

  // 启动引擎（不自动激活 workspace——由渲染端通过 workspace:get-status 决定是否需要选择界面）
  void pythonSvc.start().catch((err: unknown) => {
    console.error('[BeanWise] 引擎启动失败:', err)
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
    try {
      if (pythonSvc) await pythonSvc.stop()
    } finally {
      try {
        runtime.database?.close()
      } catch { /* already closed */ }
      app.quit()
    }
  })()
})
