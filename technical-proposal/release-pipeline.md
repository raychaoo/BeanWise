# 发行、签名与自动更新链路

> 平台范围：仅 Windows（NSIS 安装包）

## 总体流程

```plain
GitHub Actions（Windows 单平台）
   ├─ PyInstaller 打包 Python 引擎
   ├─ electron-builder 构建 + Authenticode 签名（CSC_LINK）
   └─ 产物 + latest.yml → GitHub Releases
                      ▼
            electron-updater 自动更新
```

## 触发规则

| 事件 | 动作 |
|---|---|
| push / PR → main | 测试（Vitest + pytest）+ 构建验证，不发布 |
| push tag `v*` | 完整 Windows 构建 + 签名 + 发布 GitHub Releases（草稿，人工确认） |

## 签名要求（自动更新硬性前置）

| 平台 | 要求 |
|---|---|
| Windows | Authenticode 证书（p12 / CSC_LINK），代码签名 |

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
  repo: BeanWise
win:
  target: [nsis]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

## 易错点

1. `latest.yml` 必须随产物一起发布，缺了自动更新静默失败
2. 未签名的 Windows 包会被 SmartScreen 拦截；PR 构建（无 secrets）不签名属预期
3. PyInstaller 不能交叉打包，Windows 产物必须在 Windows runner 上构建
4. GitHub Secrets 需配置：`GH_TOKEN`、`CSC_LINK`、`CSC_KEY_PASSWORD`
5. 国内网络访问 GitHub Releases 常超时，electron-updater 可能静默失败；预留镜像 / 直链 fallback 方案
