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
  - from: dist-python/beancount-engine.exe
    to: python/
publish:
  provider: github    # electron-updater 从 GitHub Releases 读 latest.yml
  owner: raychaoo
  repo: BeanWisewin:
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
