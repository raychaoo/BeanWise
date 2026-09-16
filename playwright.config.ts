import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  // 用例跑的是 out/ 构建产物（main + renderer 两端），必须先构建——见 global-setup.ts
  globalSetup: './e2e/global-setup.ts'
})
