# 发行、签名与自动更新链路

> 平台范围：仅 Windows（NSIS 安装包）

## 总体流程

```plain
GitHub Actions（Windows 单平台）
   ├─ PyInstaller 打包 Python 引擎
   ├─ electron-builder 构建（无签名口径：CSC_IDENTITY_AUTO_DISCOVERY=false）
   └─ 产物 + latest.yml → GitHub Releases
                      ▼
            electron-updater 自动更新
```

## 触发规则

| 事件 | 动作 |
|---|---|
| push / PR → main | 测试（Vitest + pytest）+ 构建验证，不发布 |
| push tag `v*` | 完整 Windows 构建（无签名）+ 发布 GitHub Releases（草稿，人工确认） |

## 签名现状（M8 裁决：放弃签名）

| 状态 | 说明 |
|---|---|
| 策略 | **不签名**：无 Authenticode 证书，不配 CSC_* secrets；electron-builder 无证书自动跳过签名（`CSC_IDENTITY_AUTO_DISCOVERY=false` 防误扫本机证书库） |
| 自动更新 | electron-updater 不校验 Authenticode，未签名包升级链路可通（latest.yml 随产物发布即可） |
| 风险 | 未签名安装包被 SmartScreen 拦截，用户需「更多信息 → 仍要运行」放行；自动更新安装同样触发 |
| 后续 | 证书到位后补一次签名发布演练（CSC_LINK/CSC_KEY_PASSWORD secrets + release.yml 恢复 env），无需改动其他链路 |

## electron-builder 关键配置

```yaml
appId: com.chaoo.beanwise
productName: BeanWise
directories:
  output: dist
files:
  - out/**            # Vite 构建产物
  - package.json
extraResources:
  # 单文件源：`to` 是目的**文件名**，必须写全（详见易错点 6）
  - from: dist-python/beancount-engine.exe
    to: python/beancount-engine.exe
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

## 易错点

1. `latest.yml` 必须随产物一起发布，缺了自动更新静默失败
2. 未签名产物 SmartScreen 拦截属预期（M8 裁决接受）
3. PyInstaller 不能交叉打包，Windows 产物必须在 Windows runner 上构建
4. GitHub Secrets 需配置：`GH_TOKEN`（CSC_LINK / CSC_KEY_PASSWORD 仅在证书到位、恢复签名时配置）
5. 国内网络访问 GitHub Releases 常超时，electron-updater 可能静默失败；预留镜像 / 直链 fallback 方案
6. **`extraResources` 单文件源的 `to` 是目的文件名，不是目录**：app-builder-lib 的 `fileMatcher.copyFiles` 对 `fromStat.isFile()` 先 `ensureNoEndSlash` 削掉尾斜杠，只有 `to` **已存在且是目录**时才追加 basename，否则直接拷成该路径。故 `to: python/` 产出的是名为 `python` 的 13MB **文件**，打包版启动引擎必 `ENOENT`（M2→M14 潜伏：dev/E2E 走 `app.isPackaged === false` 分支用本机解释器，只有安装版会踩）。改动此处后**必须验 `dist/win-unpacked/resources/python/beancount-engine.exe` 是文件**，别只看构建成功
7. **`dist-python/` 在 `.gitignore` 里，`dist:win` 必须自己重建引擎**：PyInstaller 产物不进版本库，于是它是「本地缓存」而不是「构建输入」——曾长期不随 `dist:win` 重建，导致 **2026-08-08 构建的引擎被一路打进之后每一个本地安装包**。源码里 M3 起新增的 `parse_entries`（以及 9/13 的往来对象 / `^link` / 稳定 ID）在装好的应用里报 `-32601 未知方法`，表现为**保存账本必失败 + 启动后「索引异常，数据可能不完整」弹窗常驻**（`refreshIndex` 捕获异常落 `status='error'`）。CI 无此问题（release.yml 显式先跑 `npm run build:python`），**只有本地 `npm run dist:win` 踩**；而 dev / E2E / 单测全部走未打包分支（本机解释器 + 活源码），所以这类缺陷在任何自动化检查里都不可见。现已在 `dist:win` 串上 `build:python`，并在末尾跑 `scripts/verify-dist.mjs`——它把**打包好的 exe** 起起来对 `python/engine/rpc.py` 的方法表逐个探活（返 `-32601` 即陈旧），同时校验 `resources/python/beancount-engine.exe` 是**文件**且有正常体积（防易错点 6 复现）。方法表由源码正则抽取，往 `rpc.py` 加方法不需要改脚本
8. **别用 `npm run dist:win | tail` 看结果**：管道的退出码是 `tail` 的，会把 npm/electron-builder 的失败吞成 0，让人误以为打包成功、并跳过 `verify-dist` 那一步（M14 实测踩过：`connect ETIMEDOUT` 明明是失败，回显却是「退出码 0」）。要看尾部就重定向到文件再 `tail` 那个文件
