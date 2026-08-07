# M1 脚手架与构建基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Vite + Electron + React + TypeScript 骨架，打通 dev / typecheck / 单测 / E2E / `dist:win` 出 NSIS 包 / CI 全绿。

**Architecture:** 采用 electron-vite（main / preload / renderer 三端一体构建）。主进程创建 BrowserWindow 并通过 session 头注入 CSP；preload 用 contextBridge 暴露白名单 API（形状定义在 `src/shared/api.ts`，preload 与渲染进程共享）；渲染进程是最小 React 壳。electron-builder 只打 Windows NSIS。CI 中 Python 相关步骤加 `hashFiles` 条件，待 M2 落地 `python/` 后自动启用。

**Tech Stack:** Electron（最新稳定）· electron-vite（最新）· Vite · React 19 · TypeScript strict · Vitest · Playwright（`_electron`）· electron-builder

## Global Constraints

- **平台仅 Windows**（2026-08 定稿）：NSIS 安装包、`latest.yml` 随产物发布；主进程 `window-all-closed` 直接 `app.quit()`（无 darwin 分支）
- **版本**：Node ≥22（本机 v22.10.0，CI NODE_VERSION=22）、Python 3.11（M2 才需要）、Beancount v3 锁定（本里程碑不涉及）
- **TS 严格模式**：`strict: true`；`typecheck` = `tsc --noEmit` 分别跑 node（main/preload/shared）与 web（renderer/shared）两个配置
- **CSP（约束 #8）**：生产 `default-src 'self'`；开发模式放行 `script-src 'self' 'unsafe-inline'`（react-refresh 内联脚本，2026-08-07 用户裁决）+ `connect-src ws://localhost:*`（HMR）；不放开任何远程加载 / `unsafe-eval`
- **IPC 契约锚点**：`src/shared/ipc.ts` 是通道契约唯一来源（本里程碑只建文件与命名规范，不定义业务通道，M3 填充）
- **Preload 白名单**：contextBridge 只暴露 `window.beanwise` 一个对象，形状 = `src/shared/api.ts` 的 `BeanWiseApi`
- **PyInstaller 输出固定 `dist-python/`**：本里程碑**不创建** `dist-python/`，electron-builder 的 `extraResources` 一并移除，由 M2 恢复（注释标注）
- **publish 指向实际远端**：`https://github.com/raychaoo/BeanWise.git`（文档中 `chaoo/beanwise` 是账本同步目标仓库的笔误，与发布仓库无关）
- **依赖安装**：一律 `npm i <pkg>@latest`（npm 解析 2026-08 时点的实际版本），不在 package.json 里手写版本号
- **提交**：每个任务一个 commit，消息用约定式前缀，结尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`
- **不做**：业务代码、签名（M8）、better-sqlite3（M3）、Python 引擎（M2）、Ant Design / Monaco / 图表（M4+）

---

### Task 1: 工程配置与最小可启动骨架

**Files:**
- Create: `package.json`（覆盖现有 2 行文件）
- Create: `.gitignore`
- Create: `tsconfig.node.json`、`tsconfig.web.json`
- Create: `electron.vite.config.ts`、`vitest.config.ts`、`playwright.config.ts`
- Create: `src/shared/ipc.ts`、`src/shared/api.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`、`src/renderer/src/main.tsx`、`src/renderer/src/App.tsx`、`src/renderer/src/env.d.ts`、`src/renderer/src/styles.css`

**Interfaces:**
- Produces: `BeanWiseApi { appName: string }`（`src/shared/api.ts`）——preload 注入 `window.beanwise`，Task 3 的 E2E 断言依赖它；`IpcChannel` 类型（`src/shared/ipc.ts`）——M3 沿用
- Produces: 构建产物 `out/main/index.js`（ESM）、`out/preload/index.mjs`、`out/renderer/`——Task 3 的 `electron.launch({ args: ['.'] })` 依赖 `package.json#main`

- [ ] **Step 1: 写 package.json（无依赖版本，后续 npm i 填充）**

```json
{
  "name": "beanwise",
  "productName": "BeanWise",
  "version": "0.1.0",
  "description": "BeanWise（豆账）— Beancount 复式记账桌面应用（Windows）",
  "type": "module",
  "main": "./out/main/index.js",
  "private": true,
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test:unit": "vitest run",
    "test:e2e": "npm run build && playwright test",
    "dist:win": "npm run build && electron-builder --win"
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
npm i react@latest react-dom@latest
npm i -D electron@latest electron-vite@latest vite@latest @vitejs/plugin-react@latest typescript@latest @types/node@latest @types/react@latest @types/react-dom@latest vitest@latest @playwright/test@latest electron-builder@latest
```

Expected: 安装成功；`npm ls electron electron-vite react typescript` 均列出已装版本（版本号以 npm 实际解析为准，不预锁）。

- [ ] **Step 3: 写配置文件**

`.gitignore`：

```gitignore
node_modules/
out/
dist/
dist-python/
.vite/
*.log
```

`tsconfig.node.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/main", "src/preload", "src/shared", "electron.vite.config.ts"]
}
```

`tsconfig.web.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "useDefineForClassFields": true
  },
  "include": ["src/renderer/src", "src/shared"]
}
```

`electron.vite.config.ts`：

```ts
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node'
  }
})
```

`playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list'
})
```

- [ ] **Step 4: 写 shared 契约文件**

`src/shared/ipc.ts`：

```ts
/**
 * IPC 通道契约（唯一来源）。命名规范：{domain}:{action} 小写 kebab，
 * 见 technical-proposal/implementation-roadmap.md「IPC 契约」。
 * 具体业务通道由 M3（IPC 骨架 + SQLite 索引）定义。
 */
export type IpcChannel = `${string}:${string}`
```

`src/shared/api.ts`：

```ts
/** Preload 暴露给渲染进程的白名单 API 形状（M3 扩展） */
export interface BeanWiseApi {
  appName: string
}
```

- [ ] **Step 5: 写主进程**

`src/main/index.ts`：

```ts
import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'

const CSP_PROD = "default-src 'self'"
// 开发模式：react-refresh 内联脚本（unsafe-inline）+ HMR WebSocket（用户 2026-08-07 裁决）
const CSP_DEV = "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*"

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = app.isPackaged ? CSP_PROD : CSP_DEV
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'BeanWise',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false // electron-vite ESM preload 需要；M3 安全评审再收紧
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  applyCsp()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 平台仅 Windows（2026-08 定稿）：所有窗口关闭即退出
app.on('window-all-closed', () => {
  app.quit()
})
```

- [ ] **Step 6: 写 preload**

`src/preload/index.ts`：

```ts
import { contextBridge } from 'electron'
import type { BeanWiseApi } from '../shared/api'

const api: BeanWiseApi = {
  appName: 'BeanWise'
}

contextBridge.exposeInMainWorld('beanwise', api)
```

- [ ] **Step 7: 写渲染进程壳**

`src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>BeanWise</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/env.d.ts`：

```ts
import type { BeanWiseApi } from '../../shared/api'

declare global {
  interface Window {
    beanwise: BeanWiseApi
  }
}

export {}
```

`src/renderer/src/main.tsx`：

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

`src/renderer/src/App.tsx`（Task 2 会把字面量换成共享常量，Task 3 补 preload 断言行）：

```tsx
export default function App() {
  return (
    <main>
      <h1>BeanWise</h1>
    </main>
  )
}
```

`src/renderer/src/styles.css`：

```css
:root {
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}

body {
  margin: 0;
  padding: 16px;
}
```

- [ ] **Step 8: 验证 typecheck + 构建**

Run:
```bash
npm run typecheck
npm run build
```
Expected: typecheck 无报错退出；build 产出 `out/main/index.js`、`out/preload/index.mjs`、`out/renderer/index.html`。

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .gitignore tsconfig.node.json tsconfig.web.json electron.vite.config.ts vitest.config.ts playwright.config.ts src
git commit -m "chore: 搭建 electron-vite + React + TS 最小骨架（M1）"

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

### Task 2: 单元测试基线 + 共享常量（TDD）

**Files:**
- Create: `src/shared/app.test.ts`
- Create: `src/shared/app.ts`
- Modify: `src/main/index.ts:13`（title 字面量 → 导入）、`src/preload/index.ts:5`、`src/renderer/src/App.tsx:1-7`

**Interfaces:**
- Produces: `export const APP_NAME = 'BeanWise'`（`src/shared/app.ts`）——Task 2 起 main/preload/renderer 全部从它取应用名，消除字面量重复
- Consumes: Task 1 的 vitest 配置与 `BeanWiseApi` 形状

- [ ] **Step 1: 写失败测试**

`src/shared/app.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { APP_NAME } from './app'

describe('APP_NAME', () => {
  it('为应用名称 BeanWise', () => {
    expect(APP_NAME).toBe('BeanWise')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:unit`
Expected: FAIL，`Cannot find module './app'`（src/shared/app.ts 尚不存在）

- [ ] **Step 3: 创建共享常量并替换字面量**

`src/shared/app.ts`：

```ts
/** 应用名称（唯一事实来源，各处 import） */
export const APP_NAME = 'BeanWise'
```

替换三处字面量：

`src/main/index.ts` 顶部加 `import { APP_NAME } from '../shared/app'`，`title: 'BeanWise'` → `title: APP_NAME`

`src/preload/index.ts`：

```ts
import { contextBridge } from 'electron'
import { APP_NAME } from '../shared/app'
import type { BeanWiseApi } from '../shared/api'

const api: BeanWiseApi = {
  appName: APP_NAME
}

contextBridge.exposeInMainWorld('beanwise', api)
```

`src/renderer/src/App.tsx`：

```tsx
import { APP_NAME } from '../../shared/app'

export default function App() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
    </main>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:unit`
Expected: PASS（1 个测试）

- [ ] **Step 5: typecheck 回归**

Run: `npm run typecheck`
Expected: 无报错（main/preload 走 node 配置、renderer 走 web 配置，均能解析 `../../shared/app`）

- [ ] **Step 6: Commit**

```bash
git add src/shared/app.ts src/shared/app.test.ts src/main/index.ts src/preload/index.ts src/renderer/src/App.tsx
git commit -m "test: 引入共享 APP_NAME 常量与单测基线（M1）
"
```

---

### Task 3: E2E 基线（Playwright + Electron）

**Files:**
- Create: `e2e/smoke.spec.ts`
- Modify: `src/renderer/src/App.tsx`（补 preload 断言用的节点）

**Interfaces:**
- Consumes: `package.json#main` → `out/main/index.js`（`electron.launch({ args: ['.'] })`）；`window.beanwise.appName`（Task 1 preload 注入）
- Produces: E2E 冒烟断言集——CI e2e job（Task 5）与后续所有里程碑的回归基线

- [ ] **Step 1: 写 E2E 冒烟测试**

`e2e/smoke.spec.ts`：

```ts
import { _electron as electron, expect, test } from '@playwright/test'

// GitHub Actions 的 ubuntu runner 无 user namespaces，需关 Chromium 沙箱；本机 Windows 不用
const launchArgs = process.env['CI'] ? ['.', '--no-sandbox'] : ['.']

test('应用启动并渲染主窗口', async () => {
  const app = await electron.launch({ args: launchArgs })
  const win = await app.firstWindow()

  await expect(win).toHaveTitle('BeanWise')
  await expect(win.getByRole('heading', { name: 'BeanWise' })).toBeVisible()
  // preload 白名单 API 已注入渲染进程
  await expect(win.locator('#preload-app-name')).toHaveText('BeanWise')

  await app.close()
})
```

- [ ] **Step 2: 运行确认失败（红）**

Run: `npm run test:e2e`
Expected: FAIL —— title 与 heading 断言通过，但 `#preload-app-name` 节点不存在（App.tsx 尚未渲染 preload 数据）

- [ ] **Step 3: 渲染 preload 注入的数据（实现）**

`src/renderer/src/App.tsx` 完整替换为：

```tsx
import { APP_NAME } from '../../shared/app'

export default function App() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p id="preload-app-name">{window.beanwise.appName}</p>
    </main>
  )
}
```

- [ ] **Step 4: 运行确认通过（绿）**

Run: `npm run test:e2e`
Expected: PASS（1 个测试；`test:e2e` 会先跑 `electron-vite build` 再启动 Playwright）

- [ ] **Step 5: Commit**

```bash
git add e2e/smoke.spec.ts src/renderer/src/App.tsx
git commit -m "test: Playwright Electron E2E 冒烟基线（M1）
"
```

---

### Task 4: electron-builder 出 Windows NSIS 包

**Files:**
- Modify: `electron-builder.yml`（整体替换）

**Interfaces:**
- Consumes: `out/` 构建产物；`package.json#version`（0.1.0 → 安装包版本）
- Produces: `dist/BeanWise Setup 0.1.0.exe` + `dist/latest.yml` —— Task 5 的 CI 产物与 M8 发布演练的直接输入

- [ ] **Step 1: 重写 electron-builder.yml**

完整替换为：

```yaml
appId: com.chaoo.beanwise
productName: BeanWise
directories:
  output: dist
files:
  - out/**            # Vite 构建产物
  - package.json
# extraResources（dist-python/beancount-engine）由 M2 里程碑恢复
publish:
  provider: github    # electron-updater 从 GitHub Releases 读 latest.yml
  owner: raychaoo
  repo: BeanWise
win:
  target: [nsis]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

说明：publish 指向实际远端 `raychaoo/BeanWise`（`git remote -v` 验证）；文档中的 `chaoo/beanwise` 是 M6 账本同步目标仓库，与发布仓库无关。

- [ ] **Step 2: 本地出包**

Run: `npm run dist:win`
Expected: 构建成功；`dist/` 下出现 `BeanWise Setup 0.1.0.exe` 与 `latest.yml`

- [ ] **Step 3: 人工验收（需要用户操作）**

在 Windows 资源管理器中双击 `dist/BeanWise Setup 0.1.0.exe` 安装，启动后应看到 BeanWise 窗口（标题 + h1 + preload 数据行）。安装路径可选（oneClick: false）。

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml
git commit -m "build: electron-builder 配置 Windows NSIS 单平台打包（M1）
"
```

---

### Task 5: CI 基线（Python 步骤条件化 + push 验证）

**Files:**
- Modify: `.github/workflows/release.yml`（test / e2e / build 三个 job 的 Python 步骤）

**Interfaces:**
- Consumes: Task 1-4 的 scripts（`typecheck` / `test:unit` / `test:e2e` / `dist:win`）
- Produces: CI 三 job 全绿的基线 —— M2 落地 `python/requirements*.txt` 后 Python 步骤自动启用，无需再改 workflow

- [ ] **Step 1: test job 条件化**

`.github/workflows/release.yml` 中 test job 的两个步骤加条件（`cache-dependency-path` 保持原样）：

```yaml
      - name: Install Python deps
        if: hashFiles('python/requirements-dev.txt') != ''
        run: pip install -r python/requirements-dev.txt

      - name: Python engine tests
        if: hashFiles('python/requirements-dev.txt') != ''
        run: pytest python/tests
```

- [ ] **Step 2: e2e job 条件化**

```yaml
      - name: Install Python deps
        if: hashFiles('python/requirements.txt') != ''
        run: pip install -r python/requirements.txt
```

- [ ] **Step 3: build job 条件化**

```yaml
      - name: Install Python deps
        if: hashFiles('python/requirements.txt') != ''
        run: pip install -r python/requirements.txt pyinstaller

      # PyInstaller 输出目录必须为 dist-python/（见 CLAUDE.md 约束 #5）
      - name: Build Python engine (PyInstaller)
        if: hashFiles('python/requirements.txt') != ''
        run: npm run build:python
```

统一加一行注释（放在 test job 第一个条件步骤上方）：

```yaml
      # M1 起 python/ 尚不存在，Python 步骤按文件存在性自动跳过；M2 落地后自动启用
```

- [ ] **Step 4: 本地校验 YAML**

Run:
```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml', encoding='utf-8')); print('YAML OK')"
```
Expected: `YAML OK`
说明：若 setup-python 的 `cache-dependency-path` 指向不存在文件导致 CI 报错，给对应 setup-python 步骤也加同样的 `if: hashFiles(...)` 条件。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: Python 步骤按文件存在性条件化，M1 三 job 全绿（M1）
"
```

- [ ] **Step 6: Push 并验证 CI（M1 绿灯验收）**

Run:
```bash
git push origin main
```
Expected: GitHub Actions 三个 job 全绿——
- `test`：typecheck + Vitest 通过（Python 步骤跳过）
- `e2e`：xvfb 下 Playwright Electron 冒烟通过（Python 步骤跳过）
- `build`：windows-latest 上 `dist:win` 产出 exe + latest.yml 并上传 artifact

---

## M1 绿灯验收汇总

| 验收项 | 命令 / 位置 | 判定 |
|---|---|---|
| typecheck 严格模式 | `npm run typecheck` | 0 错误 |
| 单测 | `npm run test:unit` | 1 passed |
| E2E | `npm run test:e2e` | 1 passed |
| Windows 安装包 | `npm run dist:win` + 人工安装启动 | exe 存在且可启动 |
| CI | GitHub Actions test/e2e/build | 3 jobs green |
| CSP | main/index.ts 检查 | 生产 `default-src 'self'`，无 unsafe-* |
| 平台 | 无 darwin/mac/linux 残留 | 见 roadmap 契约 |

## M2 交接说明（不在本计划内）

- `electron-builder.yml` 需恢复 `extraResources`（`dist-python/beancount-engine` → `python/beancount-engine`），注释已标注
- `package.json` 需补 `build:python` script
- CI 的 Python 步骤已条件化，M2 落地 `python/` 即自动启用
