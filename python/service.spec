# -*- mode: python ; coding: utf-8 -*-
"""BeanWise Beancount 引擎 PyInstaller 打包规格。

- 输出目录固定为 dist-python/（CLAUDE.md 约束 #5，与 electron-builder 的 dist/ 分离）
- onefile + console（stdio 服务必须 console）
- collect_all beancount + beanquery：beancount 动态导入多；beanquery 的 sources
  子包经 importlib.import_module(f'beanquery.sources.{scheme}') 动态导入，必须
  collect_all（其 hiddenimports 覆盖全部子模块），不可只收集顶层包
"""
import os

from PyInstaller.config import CONF
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = [], [], []
for _pkg in ("beancount", "beanquery"):
    _d, _b, _h = collect_all(_pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h

a = Analysis(
    ["service.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

# onefile 模式下 EXE 输出目录取自 CONF['distpath']（--distpath 默认 ./dist），
# 在 EXE() 构造前改写，保证输出固定为仓库根的 dist-python/
CONF["distpath"] = os.path.normpath(os.path.join(CONF["specpath"], "..", "dist-python"))

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="beancount-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
