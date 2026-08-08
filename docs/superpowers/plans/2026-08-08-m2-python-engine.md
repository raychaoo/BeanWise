# M2 Python 引擎层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `python/` 引擎层：stdio JSON-RPC 服务（6 方法：ping / parse_file / validate / query / render_report / shutdown）+ pytest 全绿 + PyInstaller 打包出 `dist-python/beancount-engine.exe` + Node 侧 RPC 冒烟通过（ping/validate）。

**Architecture:** `python/service.py` 为入口（`--stdio` 模式，JSONL 逐行 JSON-RPC 2.0，stdout 响应后 flush，Windows 管道显式 UTF-8）；业务封装在 `python/engine/` 包：`rpc.py`（请求分发/错误码/参数校验）、`ledger.py`（beancount load_file + 错误序列化）、`querying.py`（beanquery BQL + text/csv 渲染）。引擎无状态，每次请求独立 load_file（增量解析/缓存是 M3 的 PythonSvc 职责）。PyInstaller onefile + console 打包（spec 内改写 `CONF['distpath']` 固定输出 `dist-python/`，`collect_all` beancount + beanquery）。

**Tech Stack:** Python 3.11 · Beancount **v3**（3.2.3）· beanquery（0.2.0）· pytest · PyInstaller 6.x · Vitest（Node 侧冒烟）· npm scripts

## Global Constraints

- **版本锁定**：Python 3.11（本机经 py launcher：`py -3.11`，注意 `python` 命令是 3.8 不可用；CI 用 setup-python 3.11，PATH 上为 `python`/`python3`）；Beancount **3.2.3** 锁定（CLAUDE.md 约束 #4 禁止 v2）；beanquery **0.2.0**（v3 拆包，query 引擎独立包，必须显式收集）；pytest ≥8；PyInstaller 由 CI 单独 `pip install pyinstaller`（不改 workflow 的安装步骤）
- **硬约束（M1 最终审查裁定）**：`python/requirements.txt` 与 `python/requirements-dev.txt` 必须**同一 commit 一次性创建**——CI setup-python 的缓存条件为两文件 OR、缓存依赖两文件并存，分开提交会复发 a1f2168 修复过的失败模式（本计划 Task 1 执行）
- **协议契约（roadmap「Node ↔ Python」+ 本计划定稿，M3 PythonSvc 直接引用）**：
  - JSON-RPC 2.0，JSONL 逐行（`\n` 分隔）；批量请求（batch）不支持，一行一个请求
  - stdout 响应后必须 `flush()`；Node 侧所有请求带超时（默认 30s，M3 实现）
  - 方法清单与入参/出参（**M3 契约，值精确到字段名**）：

    | 方法 | params | result 要点 |
    |---|---|---|
    | `ping` | `{}`（不接受参数） | `{"pong": true}` |
    | `parse_file` | `{filename}` | `{entry_count, errors: [], options: {title, operating_currency: [], input_hash}}` |
    | `validate` | `{filename}` | `{errors: []}`（load_file 管线已内含校验，见 Task 2 说明） |
    | `query` | `{filename, query}` | `{types: [{name, type}], rows: [[]], errors: []}` |
    | `render_report` | `{filename, query, format: "text"\|"csv"}` | `{text, errors: []}` |
    | `shutdown` | `{}`（不接受参数） | `{"shutdown": true}`，随后进程退出 0 |

  - errors 元素：`{type, message, filename, lineno}`（`source` 的 `__tolerances__` 与 `entry` 不序列化）
  - JSON-RPC 错误码：`-32700` 解析失败（非法 JSON）/ `-32600` 无效请求 / `-32601` 未知方法 / `-32602` 参数错误 / `-32001` BQL 查询失败（应用扩展）/ `-32603` 内部错误（兜底，stderr 打 traceback）
  - `query`/`render_report` 的 rows 中 Decimal 一律转 **字符串**（保持精度，渲染端再转换）；date 转 ISO 字符串
- **PyInstaller 输出固定 `dist-python/`**（CLAUDE.md 约束 #5）：spec 内于 EXE() 构造前改写 `CONF['distpath']`（onefile 模式 EXE 输出目录取自 CONF）；`collect_all('beancount')` + `collect_all('beanquery')`（beanquery 的 `sources` 子包经 `importlib.import_module(f'beanquery.sources.{scheme}')` 动态导入，collect_all 的 hiddenimports 覆盖全部子模块，不可只收集顶层包）；`console=True`（stdio 服务）
- **extraResources 恢复**（M1 交接）：`from: dist-python/beancount-engine.exe` → `to: python/`，安装后位于 `resources/python/beancount-engine.exe`（M3 PythonSvc 打包定位点；`to` 不以文件名结尾即目录语义，避免 `python/beancount-engine/beancount-engine.exe` 嵌套）
- **文档同步**（M1 最终审查 Important-2）：`technical-proposal/release-pipeline.md` 示例 publish `owner: chaoo / repo: beanwise` → `raychaoo / BeanWise`，并同步 extraResources 示例
- **Windows 管道编码**：service 启动必须 `sys.stdin/stdout.reconfigure(encoding="utf-8")`（系统默认 GBK 会让中文 JSON 乱码/报错）；stdin 用 `errors="replace"` 防非法字节崩溃
- **fixtures 一律 ASCII**：测试账本备注不用中文（GBK 控制台/管道跨平台易乱码，且不依赖具体文案）
- **BQL 表名带 `#` 前缀**（beanquery 0.2.0 语法，与 v2 bean-query 不同）：`FROM #postings`，不是 `FROM postings`；字符串字面量 `'Assets'`（双引号亦可，语法规则 `"[^"]*"` 或 `'...'`）
- **引擎无状态**：每个请求独立 load_file（一次请求一次解析）；load_file 自带磁盘缓存（~/.cache/beancount，按 mtime+size+hash 失效），无需处理
- **提交**：每个任务一个 commit，约定式前缀，中文消息（与 M1 一致）；不附加任何 Co-Authored-By 署名
- **不做（M2 边界，roadmap「里程碑边界说明」）**：增量解析策略、PythonSvc 生命周期、SQLite（M3）；AI 解析（主进程代理，不经 Python）；IPC 业务通道定义（M3）；业务 UI（M4+）

---

### Task 1: 引擎骨架 + stdio JSON-RPC 循环 + ping（双 requirements 同 commit）

**Files:**
- Create: `python/requirements.txt`、`python/requirements-dev.txt`（**同一 commit**）
- Create: `python/pytest.ini`
- Create: `python/engine/__init__.py`（空文件）
- Create: `python/engine/rpc.py`（JSON-RPC 分发 + ping，不含 ledger/querying 导入——后两个文件本任务尚不存在）
- Create: `python/service.py`（`--stdio` 循环）
- Create: `python/tests/test_service.py`（进程内分发测试）
- Create: `python/tests/test_service_loop.py`（真实子进程循环测试）
- Modify: `.gitignore`（补 Python 忽略项）

**Interfaces:**
- Produces: `handle_request(line: str) -> dict | None`（`engine/rpc.py`）——Task 2/3 扩展 METHODS 表；`service.py --stdio` 入口——Task 4 的 Vitest 冒烟与 Task 5 的 PyInstaller 均以其为入口
- Produces: 双 requirements 文件——Task 4 起 CI 的 setup-python / pip 步骤自动启用（M1 已条件化，无需改 workflow）

- [ ] **Step 1: .gitignore 补 Python 忽略项**

`.gitignore` 追加（现有内容保持）：

```gitignore
build/
__pycache__/
*.py[cod]
.pytest_cache/
```

- [ ] **Step 2: 创建双 requirements 文件（同一 commit，硬约束）**

`python/requirements.txt`：

```txt
# BeanWise Python 引擎运行时依赖（Beancount v3 锁定，禁止 v2）
beancount==3.2.3
beanquery==0.2.0
```

`python/requirements-dev.txt`：

```txt
# 开发/测试依赖（CI test job 与本地 pytest 用）
-r requirements.txt
pytest>=8
```

- [ ] **Step 3: 安装本地 Python 依赖**

Run:
```bash
py -3.11 -m pip install -r python/requirements-dev.txt
```
说明：本机已于 2026-08-08 验证 beancount 3.2.3 + beanquery 0.2.0 + pyinstaller 6.21.0 可安装（全部有 Windows 轮子，无需编译器）。CI 由 workflow 自动安装（Task 1 commit 后自动启用）。

- [ ] **Step 4: 写 pytest 配置**

`python/pytest.ini`：

```ini
[pytest]
# 让 tests 能 import engine 包（pytest>=7 的 pythonpath 机制；rootdir 为 python/）
pythonpath = .
```

- [ ] **Step 5: 写进程内分发测试（红）**

`python/tests/test_service.py`：

```python
"""RPC 分发单元测试（进程内直接调用 handle_request）。"""
from engine.rpc import handle_request


def _result(line: str) -> dict:
    response = handle_request(line)
    assert response is not None
    assert "error" not in response
    return response["result"]


def test_ping():
    assert _result('{"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}}') == {"pong": True}


def test_invalid_json_returns_parse_error():
    response = handle_request("{not json")
    assert response["error"]["code"] == -32700
    assert response["id"] is None


def test_non_dict_request_rejected():
    response = handle_request("[1, 2]")
    assert response["error"]["code"] == -32600


def test_unknown_method():
    response = handle_request('{"jsonrpc": "2.0", "id": 2, "method": "nope", "params": {}}')
    assert response["error"]["code"] == -32601


def test_ping_with_params_rejected():
    response = handle_request('{"jsonrpc": "2.0", "id": 3, "method": "ping", "params": {"x": 1}}')
    assert response["error"]["code"] == -32602


def test_bad_params_type_rejected():
    response = handle_request('{"jsonrpc": "2.0", "id": 4, "method": "ping", "params": [1]}')
    assert response["error"]["code"] == -32602


def test_notification_gets_no_response():
    assert handle_request('{"jsonrpc": "2.0", "method": "ping", "params": {}}') is None
```

- [ ] **Step 6: 运行确认失败（红）**

Run: `py -3.11 -m pytest python/tests`
Expected: FAIL——`ModuleNotFoundError: No module named 'engine'`（engine 包尚未创建）

- [ ] **Step 7: 写 engine 包与 RPC 分发（实现）**

`python/engine/__init__.py`：空文件。

`python/engine/rpc.py`：

```python
"""JSON-RPC 2.0 请求分发（stdio 服务用）。

错误码（JSON-RPC 2.0 规范 + 应用扩展）：
  -32700 解析错误（非法 JSON）
  -32600 无效请求（非对象 / 缺 method）
  -32601 方法不存在
  -32602 无效参数
  -32001 BQL 查询失败（应用扩展，Task 3 引入）
  -32603 内部错误（兜底，stderr 留痕）
"""
import json
import sys
import traceback


class RpcError(Exception):
    """带 JSON-RPC 错误码的协议错误。"""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def _require_string(params: dict, key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RpcError(-32602, f"参数 {key!r} 必须是非空字符串")
    return value


def _ping(params: dict) -> dict:
    if params:
        raise RpcError(-32602, "ping 不接受参数")
    return {"pong": True}


def _shutdown(params: dict) -> dict:
    if params:
        raise RpcError(-32602, "shutdown 不接受参数")
    return {"shutdown": True}


METHODS = {
    "ping": _ping,
    "shutdown": _shutdown,  # 本任务即需：service.py 循环与 test_service_loop.py 依赖它
    # parse_file / validate（Task 2）、query / render_report（Task 3）在此注册
}


def handle_request(line: str) -> dict | None:
    """处理一行 JSON-RPC 请求，返回响应 dict；通知（无 id）返回 None。"""
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"JSON 解析失败: {exc}"}}

    if not isinstance(request, dict) or not isinstance(request.get("method"), str):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "请求必须是包含 method 的 JSON 对象"}}

    method = request["method"]
    params = request.get("params", {})
    if not isinstance(params, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32602, "message": "params 必须是对象"}}
    request_id = request.get("id")

    handler = METHODS.get(method)
    if handler is None:
        response = {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"未知方法: {method}"}}
    else:
        try:
            response = {"jsonrpc": "2.0", "id": request_id, "result": handler(params)}
        except RpcError as exc:
            response = {"jsonrpc": "2.0", "id": request_id, "error": {"code": exc.code, "message": str(exc)}}
        except Exception as exc:  # 兜底：未预期异常按内部错误返回，stderr 留痕
            traceback.print_exc(file=sys.stderr)
            response = {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": f"内部错误: {exc}"}}

    if request_id is None:
        return None  # 通知不响应
    return response
```

- [ ] **Step 8: 运行确认通过（绿）**

Run: `py -3.11 -m pytest python/tests`
Expected: PASS（7 个用例，test_service_loop.py 尚不存在）

- [ ] **Step 9: 写子进程循环测试（红）**

`python/tests/test_service_loop.py`：

```python
"""service.py stdio 循环冒烟测试（真实子进程，覆盖 flush / shutdown 退出）。"""
import json
import os
import subprocess
import sys
from pathlib import Path

SERVICE = Path(__file__).parent.parent / "service.py"
# Windows 用 py launcher（本机 `python` 命令是 3.8 不可用），其他平台 python3；
# 可用环境变量 BEANWISE_PYTHON_CMD 覆盖，如 'py -3.11' / 'python3'
PYTHON = (
    os.environ.get("BEANWISE_PYTHON_CMD") or ("py -3.11" if sys.platform == "win32" else "python3")
).split()


def test_ping_then_shutdown():
    proc = subprocess.Popen(
        [*PYTHON, str(SERVICE), "--stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert proc.stdout is not None and proc.stdin is not None
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}}) + "\n")
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": {}}) + "\n")
    proc.stdin.flush()
    lines = [json.loads(line) for line in proc.stdout]
    assert lines[0]["result"] == {"pong": True}
    assert lines[1]["result"] == {"shutdown": True}
    assert proc.wait(timeout=10) == 0
```

- [ ] **Step 10: 写 service.py 入口（实现）**

`python/service.py`：

```python
#!/usr/bin/env python3
"""BeanWise Beancount 引擎 —— stdio JSON-RPC 2.0 服务。

协议（roadmap「Node ↔ Python」）：JSONL 逐行（每行一个 JSON-RPC 请求，\\n 分隔）；
每个请求必须逐行响应并 flush，否则 Node 端收不到。方法：ping / parse_file / validate /
query / render_report / shutdown（见 engine/rpc.py METHODS）。
"""
import argparse
import json
import sys

from engine.rpc import handle_request


def main() -> int:
    parser = argparse.ArgumentParser(prog="beancount-engine")
    parser.add_argument("--stdio", action="store_true", help="以 stdio JSON-RPC 模式运行")
    parser.add_argument("--version", action="store_true", help="打印版本后退出")
    args = parser.parse_args()

    if args.version:
        print("beancount-engine 0.1.0")
        return 0
    if not args.stdio:
        parser.error("--stdio 是唯一运行模式")

    # Windows 管道默认系统编码（GBK），必须显式 UTF-8，否则中文 JSON 乱码/报错；
    # stdin 用 errors=replace，非法字节不崩溃
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        response = handle_request(line)
        if response is None:
            continue
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()  # 必须 flush，否则 Node 端收不到
        result = response.get("result") or {}
        if result.get("shutdown") is True:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 11: 运行确认通过（绿）**

Run: `py -3.11 -m pytest python/tests`
Expected: PASS（8 个用例；子进程用例含 Python 首次启动 1~3s，属预期）

- [ ] **Step 12: 手动冒烟（管道模式）**

Run:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}' | py -3.11 python/service.py --stdio
```
Expected: stdout 输出 `{"jsonrpc": "2.0", "id": 1, "result": {"pong": true}}` 且管道关闭后进程退出 0。

- [ ] **Step 13: Commit**

```bash
git add .gitignore python/
git commit -m "feat: Python 引擎骨架 + stdio JSON-RPC 循环 + ping（M2）
"
```

---

### Task 2: parse_file + validate（错误序列化 + fixtures）

**Files:**
- Create: `python/tests/fixtures/main.beancount`、`python/tests/fixtures/bad.beancount`（全 ASCII）
- Create: `python/engine/ledger.py`
- Create: `python/tests/test_ledger.py`
- Modify: `python/engine/rpc.py`（注册 parse_file / validate）

**Interfaces:**
- Consumes: Task 1 的 `RpcError` / `_require_string`（`engine/rpc.py`）
- Produces: `ledger.parse_file(filename: str) -> dict`、`ledger.validate(filename: str) -> dict`——Task 4 的 Vitest 冒烟与 M3 PythonSvc 直接消费；`python/tests/fixtures/main.beancount` 是合法账本 fixture——Task 4 冒烟与 M3 E2E 复用

- [ ] **Step 1: 写 fixtures（ASCII）**

`python/tests/fixtures/main.beancount`（合法账本，3 open + 2 交易 = 5 entries）：

```beancount
option "title" "BeanWise Test Ledger"
option "operating_currency" "CNY"

2026-01-01 open Assets:Bank:CNB
2026-01-01 open Equity:Opening-Balances
2026-01-01 open Expenses:Food

2026-01-02 * "Breakfast"
  Assets:Bank:CNB  -15.00 CNY
  Expenses:Food

2026-01-03 * "Coffee"
  Assets:Bank:CNB  -25.00 CNY
  Expenses:Food
```

`python/tests/fixtures/bad.beancount`（未配平 → ValidationError，3 entries + 1 error）：

```beancount
option "title" "Bad Ledger"
option "operating_currency" "CNY"

2026-01-01 open Assets:Bank:CNB
2026-01-01 open Equity:Opening-Balances

2026-01-02 * "Unbalanced"
  Assets:Bank:CNB  -15.00 CNY
```

- [ ] **Step 2: 写测试（红）**

`python/tests/test_ledger.py`：

```python
"""parse_file / validate 方法测试。"""
from pathlib import Path

from engine.ledger import parse_file, validate

FIXTURES = Path(__file__).parent / "fixtures"
MAIN = str(FIXTURES / "main.beancount")
BAD = str(FIXTURES / "bad.beancount")
MISSING = str(FIXTURES / "missing.beancount")


def test_parse_file_valid_ledger():
    result = parse_file(MAIN)
    assert result["entry_count"] == 5
    assert result["errors"] == []
    assert result["options"]["title"] == "BeanWise Test Ledger"
    assert result["options"]["operating_currency"] == ["CNY"]


def test_parse_file_reports_validation_errors():
    result = parse_file(BAD)
    assert result["entry_count"] == 3
    assert len(result["errors"]) == 1
    error = result["errors"][0]
    assert set(error) == {"type", "message", "filename", "lineno"}
    assert error["type"] == "ValidationError"
    assert "does not balance" in error["message"]
    assert error["filename"].endswith("bad.beancount")
    assert isinstance(error["lineno"], int)


def test_parse_file_missing_file_returns_load_error():
    result = parse_file(MISSING)
    assert result["entry_count"] == 0
    assert result["errors"][0]["type"] == "LoadError"


def test_validate_matches_parse_errors():
    assert validate(BAD)["errors"] == parse_file(BAD)["errors"]
```

- [ ] **Step 3: 运行确认失败（红）**

Run: `py -3.11 -m pytest python/tests/test_ledger.py`
Expected: FAIL——`ModuleNotFoundError: No module named 'engine.ledger'`

- [ ] **Step 4: 写 ledger.py（实现）**

`python/engine/ledger.py`：

```python
"""Beancount 文件加载 / 校验封装。

说明：load_file 的管线（beancount.loader._load）已包含 booking 与
beancount.ops.validation.validate（v3 实测：未配平交易在 load errors 中即报
ValidationError）。因此 validate 与 parse_file 共享同一加载管线，返回的全量
错误列表（解析 + 记账 + 校验）完全一致——M3 校验流程可任选其一，或两者都调做冗余。
"""
from beancount import loader


def _serialize_errors(errors) -> list[dict]:
    """把 beancount 错误对象转成 JSON 友好 dict（不序列化 entry 与 __tolerances__）。"""
    out = []
    for err in errors:
        item = {
            "type": type(err).__name__,
            "message": err.message,
        }
        source = getattr(err, "source", None)
        if isinstance(source, dict):
            item["filename"] = source.get("filename")
            item["lineno"] = source.get("lineno")
        out.append(item)
    return out


def _serialize_options(options) -> dict:
    return {
        "title": options.get("title"),
        "operating_currency": list(options.get("operating_currency") or []),
        "input_hash": options.get("input_hash"),
    }


def parse_file(filename: str) -> dict:
    """解析文件，返回条目数 + 错误列表 + options 摘要。"""
    entries, errors, options = loader.load_file(filename)
    return {
        "entry_count": len(entries),
        "errors": _serialize_errors(errors),
        "options": _serialize_options(options),
    }


def validate(filename: str) -> dict:
    """显式校验入口：返回全量错误列表（与 parse_file.errors 相同，见模块 docstring）。"""
    _entries, errors, _options = loader.load_file(filename)
    return {"errors": _serialize_errors(errors)}
```

- [ ] **Step 5: rpc.py 注册两个方法**

`python/engine/rpc.py` 顶部加导入：

```python
from . import ledger
```

`_ping` 之后、`METHODS` 之前加两个 handler：

```python
def _parse_file(params: dict) -> dict:
    filename = _require_string(params, "filename")
    return ledger.parse_file(filename)


def _validate(params: dict) -> dict:
    filename = _require_string(params, "filename")
    return ledger.validate(filename)
```

`METHODS` 表改为：

```python
METHODS = {
    "ping": _ping,
    "parse_file": _parse_file,
    "validate": _validate,
    # query / render_report（Task 3）在此注册
}
```

- [ ] **Step 6: 运行确认通过（绿）**

Run: `py -3.11 -m pytest python/tests`
Expected: PASS（12 个用例）

- [ ] **Step 7: Commit**

```bash
git add python/
git commit -m "feat: 引擎 parse_file / validate 方法与错误序列化（M2）
"
```

---

### Task 3: query + render_report（beanquery BQL + 文本/CSV 渲染）

**Files:**
- Create: `python/engine/querying.py`
- Create: `python/tests/test_query.py`
- Modify: `python/engine/rpc.py`（注册 query / render_report）

**Interfaces:**
- Consumes: Task 1 的 `RpcError` / `_require_string`；Task 2 的 `ledger._serialize_errors`（同包内复用）
- Produces: `querying.run_query(filename, query_string) -> dict`、`querying.render_report(filename, query_string, fmt) -> dict`、`querying.QueryError`——M3/M8 图表数据源与报表渲染入口

- [ ] **Step 1: 写测试（红）**

`python/tests/test_query.py`：

```python
"""query / render_report 方法测试。"""
from pathlib import Path

import pytest

from engine.querying import QueryError, render_report, run_query

FIXTURES = Path(__file__).parent / "fixtures"
MAIN = str(FIXTURES / "main.beancount")
MISSING = str(FIXTURES / "missing.beancount")

# 注意 beanquery 0.2.0 的表名带 # 前缀（v2 的 FROM open 语法已失效）
QUERY = "SELECT account, sum(position) FROM #postings WHERE account ~ 'Assets' GROUP BY account"


def test_query_returns_types_and_rows():
    result = run_query(MAIN, QUERY)
    assert result["errors"] == []
    assert [t["name"] for t in result["types"]] == ["account", "sum(position) (CNY)"]
    assert result["types"][0]["type"] == "str"
    assert result["rows"] == [["Assets:Bank:CNB", "-40.00"]]  # Decimal 序列化为字符串


def test_query_bad_bql_raises():
    with pytest.raises(QueryError):
        run_query(MAIN, "SELECT FROM")  # 语法错误


def test_query_load_errors_surfaced():
    result = run_query(MISSING, QUERY)
    assert result["errors"][0]["type"] == "LoadError"
    assert result["rows"] == []


def test_render_report_text():
    result = render_report(MAIN, QUERY, "text")
    assert "Assets:Bank:CNB" in result["text"]
    assert "-40.00" in result["text"]


def test_render_report_csv():
    result = render_report(MAIN, QUERY, "csv")
    assert "account" in result["text"]
    assert "Assets:Bank:CNB,-40.00" in result["text"]
```

- [ ] **Step 2: 运行确认失败（红）**

Run: `py -3.11 -m pytest python/tests/test_query.py`
Expected: FAIL——`ModuleNotFoundError: No module named 'engine.querying'`

- [ ] **Step 3: 写 querying.py（实现）**

`python/engine/querying.py`：

```python
"""BQL 查询与报表渲染封装（beanquery，beancount v3 拆包）。"""
import io
from datetime import date, datetime
from decimal import Decimal

from beancount import loader
from beanquery import query as bq
from beanquery.compiler import CompilationError
from beanquery.parser import ParseError
from beanquery.query_render import render_csv, render_text

from .ledger import _serialize_errors


class QueryError(Exception):
    """BQL 查询失败（语法 / 编译错误），由 rpc.py 映射为 -32001。"""


def _json_value(value):
    if isinstance(value, Decimal):
        return str(value)  # 保持精度，字符串传输（渲染端再转换）
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def _type_name(t) -> str:
    return getattr(t, "__name__", str(t))


def _run_query(entries, options, query_string: str):
    try:
        # 注意：run_query 内部会 query.format(*args)，查询文本含字面 {} 会抛
        # ValueError（落在 -32603），属预期边界
        return bq.run_query(entries, options, query_string, numberify=True)
    except (ParseError, CompilationError) as exc:
        raise QueryError(str(exc)) from exc


def run_query(filename: str, query_string: str) -> dict:
    entries, errors, options = loader.load_file(filename)
    result_types, result_rows = _run_query(entries, options, query_string)
    return {
        "types": [{"name": col.name, "type": _type_name(col._type)} for col in result_types],
        "rows": [[_json_value(v) for v in row] for row in result_rows],
        "errors": _serialize_errors(errors),
    }


def render_report(filename: str, query_string: str, fmt: str = "text") -> dict:
    entries, errors, options = loader.load_file(filename)
    result_types, result_rows = _run_query(entries, options, query_string)
    out = io.StringIO()
    dcontext = options["dcontext"]
    if fmt == "csv":
        render_csv(result_types, result_rows, dcontext, out)
    else:
        render_text(result_types, result_rows, dcontext, out, unicode=False)
    return {"text": out.getvalue(), "errors": _serialize_errors(errors)}
```

- [ ] **Step 4: rpc.py 注册两个方法**

`python/engine/rpc.py` 顶部加导入：

```python
from . import querying
```

`_validate` 之后加两个 handler：

```python
def _query(params: dict) -> dict:
    filename = _require_string(params, "filename")
    query_string = _require_string(params, "query")
    try:
        return querying.run_query(filename, query_string)
    except querying.QueryError as exc:
        raise RpcError(-32001, str(exc)) from exc


def _render_report(params: dict) -> dict:
    filename = _require_string(params, "filename")
    query_string = _require_string(params, "query")
    fmt = params.get("format", "text")
    if fmt not in ("text", "csv"):
        raise RpcError(-32602, "format 只能是 'text' 或 'csv'")
    try:
        return querying.render_report(filename, query_string, fmt)
    except querying.QueryError as exc:
        raise RpcError(-32001, str(exc)) from exc  # 与 _query 对称：坏 BQL 统一 -32001
```

`METHODS` 表改为（`_shutdown` 已在 Task 1 定义，此处只补注册完整形态）：

```python
METHODS = {
    "ping": _ping,
    "parse_file": _parse_file,
    "validate": _validate,
    "query": _query,
    "render_report": _render_report,
    "shutdown": _shutdown,
}
```

- [ ] **Step 5: 运行确认通过（绿）**

Run: `py -3.11 -m pytest python/tests`
Expected: PASS（17 个用例）

- [ ] **Step 6: 手动验证 6 方法全链路**

Run:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"query","params":{"filename":"python/tests/fixtures/main.beancount","query":"SELECT account, sum(position) FROM #postings WHERE account ~ '\''Assets'\'' GROUP BY account"}}' | py -3.11 python/service.py --stdio
```
Expected: 返回 `"rows": [["Assets:Bank:CNB", "-40.00"]]`（注意 bash 嵌套引号转义；Windows 下用双引号包 BQL、单引号包字符串亦可）。

- [ ] **Step 7: Commit**

```bash
git add python/
git commit -m "feat: 引擎 query / render_report 方法（BQL + 文本/CSV 渲染）（M2）
"
```

---

### Task 4: Node 侧 RPC 冒烟（Vitest）+ CI 顺序调整 + 文档同步

**Files:**
- Create: `src/main/python-engine-smoke.test.ts`
- Modify: `.github/workflows/release.yml`（test job 的 pip 安装前置）
- Modify: `technical-proposal/release-pipeline.md`（publish owner/repo 同步 + extraResources 示例同步）

**Interfaces:**
- Consumes: Task 1 的 `python/service.py --stdio`；Task 2 的 `python/tests/fixtures/main.beancount`
- Produces: 引擎 stdio 协议回归基线（后续里程碑与 CI 复用）；CI test job 在 python 依赖就绪后跑前端单测的固定顺序

- [ ] **Step 1: 写 Vitest 冒烟测试**

`src/main/python-engine-smoke.test.ts`：

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'

// M2 引擎冒烟：spawn Python 引擎（stdio JSON-RPC）验证 ping / validate / shutdown
// 本机 Windows 用 py launcher（`python` 命令是 3.8 不可用），CI ubuntu 用 python3；
// 可用环境变量 BEANWISE_PYTHON_CMD 覆盖，如 'py -3.11' / 'python3'
const PYTHON =
  process.env['BEANWISE_PYTHON_CMD']?.split(' ') ??
  (process.platform === 'win32' ? ['py', '-3.11'] : ['python3'])
const SERVICE = resolve('python/service.py')
const FIXTURE = resolve('python/tests/fixtures/main.beancount')

interface RpcResponse {
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface Engine {
  proc: ChildProcess
  request: (payload: unknown) => Promise<RpcResponse>
  stop: () => Promise<void>
}

function startEngine(): Engine {
  const proc = spawn(PYTHON[0], [...PYTHON.slice(1), SERVICE, '--stdio'], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  proc.stdin!.on('error', () => {}) // 进程提前退出时忽略管道错误
  proc.stdout!.on('error', () => {})
  const rl = createInterface({ input: proc.stdout! })
  const pending: Array<(value: RpcResponse) => void> = []
  rl.on('line', (line) => {
    pending.shift()?.(JSON.parse(line) as RpcResponse)
  })
  const request = (payload: unknown) =>
    new Promise<RpcResponse>((resolvePromise) => {
      pending.push(resolvePromise)
      proc.stdin!.write(JSON.stringify(payload) + '\n')
    })
  const stop = async () => {
    try {
      await request({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: {} })
    } catch {
      // 进程已退出则忽略
    }
    await Promise.race([
      new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit())),
      new Promise<void>((resolveExit) => setTimeout(resolveExit, 5000))
    ])
    if (proc.exitCode === null) proc.kill()
  }
  return { proc, request, stop }
}

describe('Python 引擎 stdio JSON-RPC 冒烟（M2）', () => {
  it('ping 往返返回 pong', async () => {
    const engine = startEngine()
    const res = await engine.request({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
    expect(res.result).toEqual({ pong: true })
    await engine.stop()
  })

  it('validate 合法账本返回空错误列表', async () => {
    const engine = startEngine()
    const res = await engine.request({
      jsonrpc: '2.0',
      id: 2,
      method: 'validate',
      params: { filename: FIXTURE }
    })
    expect(res.result).toEqual({ errors: [] })
    await engine.stop()
  })

  it('shutdown 优雅退出（exit 0）', async () => {
    const engine = startEngine()
    const exit = new Promise<number | null>((resolveExit) =>
      engine.proc.on('exit', (code) => resolveExit(code))
    )
    const res = await engine.request({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} })
    expect(res.result).toEqual({ shutdown: true })
    await expect(exit).resolves.toBe(0)
  })
}, 30_000)
```

- [ ] **Step 2: 运行确认通过（绿）**

Run: `npm run test:unit`
Expected: PASS（原有 1 个 APP_NAME 用例 + 3 个引擎冒烟用例 = 4 passed；Python 首次启动 1~3s 属预期）

- [ ] **Step 3: CI test job 调整顺序（pip 安装前置）**

`.github/workflows/release.yml` 的 test job：把「Install Python deps」步骤移到 `npm ci` 之后、`TypeScript typecheck` 之前，并更新注释（M2 落地后 Python 步骤不再跳过）：

```yaml
      - name: Install Node deps
        run: npm ci

      # M2 起 python/ 落地：引擎冒烟（Vitest）与 pytest 都需要 beancount，pip 安装前置
      - name: Install Python deps
        if: hashFiles('python/requirements-dev.txt') != ''
        run: pip install -r python/requirements-dev.txt

      - name: TypeScript typecheck
        run: npm run typecheck

      - name: Frontend unit tests
        run: npm run test:unit

      - name: Python engine tests
        if: hashFiles('python/requirements-dev.txt') != ''
        run: pytest python/tests
```

其余 job（e2e / build）不动——e2e 不跑 Vitest，build 的 `dist:win` 需在 `npm run build:python` 之后（顺序已满足）。

- [ ] **Step 4: 文档同步（M1 最终审查 Important-2）**

`technical-proposal/release-pipeline.md` 的 electron-builder 示例段（约第 39-46 行）替换为：

```yaml
extraResources:
  - from: dist-python/beancount-engine.exe
    to: python/
publish:
  provider: github    # electron-updater 从 GitHub Releases 读 latest.yml
  owner: raychaoo
  repo: BeanWise
```

- [ ] **Step 5: Commit**

```bash
git add src/main/python-engine-smoke.test.ts .github/workflows/release.yml technical-proposal/release-pipeline.md
git commit -m "test: Node 侧引擎 RPC 冒烟测试 + CI 顺序调整 + 文档同步（M2）
"
```

---

### Task 5: PyInstaller 打包集成（spec + build:python + extraResources）

**Files:**
- Create: `python/service.spec`
- Create: `scripts/build-python.mjs`
- Modify: `package.json`（补 `build:python` script）
- Modify: `electron-builder.yml`（恢复 extraResources）

**Interfaces:**
- Consumes: Task 1 的 `python/service.py`（spec 入口）；`py -3.11 -m pip install pyinstaller`（本机 2026-08-08 已装 6.21.0；CI 的 build job 已单独安装）
- Produces: `dist-python/beancount-engine.exe`（PyInstaller 固定输出，CLAUDE.md 约束 #5）——extraResources 打入安装包后为 `resources/python/beancount-engine.exe`，M3 PythonSvc 定位点

- [ ] **Step 1: 写 PyInstaller spec**

`python/service.spec`：

```python
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
```

- [ ] **Step 2: 写解释器解析脚本**

`scripts/build-python.mjs`：

```js
#!/usr/bin/env node
// 运行 PyInstaller 打包 Beancount 引擎（输出 dist-python/，CLAUDE.md 约束 #5）
// 解释器解析：Windows 优先 py launcher 的 3.11（本机 `python` 命令是 3.8，不可用），
// 其他平台 python3；逐个降级，全部失败时打印原因。
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const spec = resolve(process.cwd(), 'python/service.spec')
const candidates =
  process.platform === 'win32'
    ? [
        ['py', '-3.11', '-m', 'PyInstaller'],
        ['python', '-m', 'PyInstaller']
      ]
    : [
        ['python3', '-m', 'PyInstaller'],
        ['python', '-m', 'PyInstaller']
      ]

for (const cmd of candidates) {
  const result = spawnSync(cmd[0], [...cmd.slice(1), spec, '--noconfirm'], { stdio: 'inherit' })
  if (result.status === 0) {
    process.exit(0)
  }
  const reason = result.error ? result.error.message : `退出码 ${result.status}`
  console.warn(`[build-python] ${cmd.join(' ')} 失败：${reason}`)
}

console.error('[build-python] 打包失败：未找到可用解释器，请确认 Python 3.11 已安装且 pip install pyinstaller')
process.exit(1)
```

- [ ] **Step 3: package.json 补 script**

`package.json` 的 scripts 中 `dist:win` 之后加一行：

```json
    "build:python": "node scripts/build-python.mjs",
```

（M1 交接说明的待办项；CI build job 的「Build Python engine (PyInstaller)」步骤已调用 `npm run build:python`，无需改 workflow。）

- [ ] **Step 4: electron-builder.yml 恢复 extraResources**

`electron-builder.yml` 中删除注释行、恢复 extraResources（`to` 为目录语义，安装后位于 `resources/python/beancount-engine.exe`）：

```yaml
extraResources:
  # M2：PyInstaller 产物打入安装包（resources/python/beancount-engine.exe，M3 PythonSvc 定位点）
  - from: dist-python/beancount-engine.exe
    to: python/
```

- [ ] **Step 5: 本地打包**

Run: `npm run build:python`
Expected: 构建成功，日志末尾显示 `Build complete! The results are available in: <仓库根>/dist-python`；`dist-python/beancount-engine.exe` 存在（首次打包 1~3 分钟，onefile 解压验证属正常）。

- [ ] **Step 6: 打包产物冒烟**

Run:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}' | dist-python/beancount-engine.exe --stdio
```
Expected: 输出 pong 响应后退出（onefile 首次启动含 1~3s 解压延迟）。再验证 validate：

```bash
echo '{"jsonrpc":"2.0","id":2,"method":"validate","params":{"filename":"python/tests/fixtures/main.beancount"}}' | dist-python/beancount-engine.exe --stdio
```
Expected: 返回 `{"errors": []}`。

- [ ] **Step 7: 回归确认**

Run: `py -3.11 -m pytest python/tests` 与 `npm run test:unit`
Expected: 全部通过（打包不影响源码测试）。

- [ ] **Step 8: Commit**

```bash
git add python/service.spec scripts/build-python.mjs package.json electron-builder.yml
git commit -m "build: PyInstaller 打包引擎 + extraResources 恢复（M2）
"
```

---

### Task 6: M2 绿灯验收（本机全量 + push + CI 三 job 全绿）

**Files:** 无代码变更。

**Interfaces:**
- Consumes: Task 1-5 的全部产物（pytest / Vitest 冒烟 / dist-python 打包 / extraResources）
- Produces: M2 绿灯验收记录（roadmap 里程碑表 M2 行）与 CI 基线（push main 触发三 job）

- [ ] **Step 1: 本机全量验收**

Run:
```bash
py -3.11 -m pytest python/tests
npm run typecheck
npm run test:unit
```
Expected: pytest 18 passed；typecheck 0 错误；vitest 4 passed（1 个 M1 用例 + 3 个引擎冒烟）。

- [ ] **Step 2: 检查打包产物与配置**

Run:
```bash
ls -lh dist-python/
git diff HEAD~5 --stat   # 确认 5 个 M2 commit 的改动范围
```
Expected: `beancount-engine.exe` 存在（onefile，体积 ~40-80MB 属正常）；改动范围含 python/、scripts/、src/main/python-engine-smoke.test.ts、package.json、electron-builder.yml、.github/workflows/release.yml、technical-proposal/release-pipeline.md、.gitignore。

- [ ] **Step 3: Push 并验证 CI（M2 绿灯验收）**

Run:
```bash
git push origin main
```
Expected: GitHub Actions 三个 job 全绿——
- `test`（ubuntu）：typecheck + Vitest（含引擎冒烟 3 用例，Python 依赖已前置安装）+ pytest 18 passed
- `e2e`（ubuntu，xvfb）：Playwright Electron 冒烟通过
- `build`（windows-latest）：`npm run build:python` 出 `dist-python/beancount-engine.exe` → `dist:win` 出 exe + latest.yml（extraResources 已含引擎）并上传 artifact

若 build job 失败，优先按 CLAUDE.md「常见坑」排障：`%TEMP%\eb-dl-*.lock` 与孤儿 node/electron 进程、镜像变量（`ELECTRON_MIRROR` + `ELECTRON_BUILDER_BINARIES_MIRROR` 缺一不可）。

---

## M2 绿灯验收汇总

| 验收项 | 命令 / 位置 | 判定 |
|---|---|---|
| Python 引擎测试 | `py -3.11 -m pytest python/tests` | 18 passed |
| Node 侧 RPC 冒烟 | `npm run test:unit` | 4 passed（含 ping/validate/shutdown） |
| PyInstaller 打包 | `npm run build:python` | `dist-python/beancount-engine.exe` 存在且 ping 冒烟通过 |
| extraResources | electron-builder.yml | from/to 正确；CI build job 产物含引擎 |
| 双 requirements 同 commit | `git log --oneline` | requirements.txt 与 requirements-dev.txt 同一 commit 引入 |
| 协议 | service.py 检查 | JSONL 逐行、stdout flush、UTF-8 reconfigure、shutdown 退出 0 |
| 文档同步 | release-pipeline.md | publish owner/repo 为 raychaoo/BeanWise |
| CI | GitHub Actions test/e2e/build | 3 jobs green |

## M3 交接说明（不在本计划内）

- **引擎定位**：开发模式 `py -3.11 python/service.py --stdio`（或 `python3`，CI 无 launcher）；打包后 `join(process.resourcesPath, 'python/beancount-engine.exe')`（extraResources `to: python/` 的落点），`--stdio` 参数照传
- **方法契约**：本计划 Global Constraints 的「协议契约」表即 M3 PythonSvc 的入参/出参规格（字段名精确）；JSON-RPC 错误码表同上；引擎无状态，一次请求一次 load_file
- **回归基线**：`src/main/python-engine-smoke.test.ts` 是引擎 stdio 协议回归测试（CI test job 已把 pip 安装前置），M3 扩展 PythonSvc 时保持其通过
- **CI 状态**：M1 的 Python 步骤条件化已全部启用（requirements 落地即生效），test job 顺序为 npm ci → pip install → typecheck → test:unit → pytest
- **测试钩子（M1 最终审查 Important-1，M3 落实）**：生产 CSP（CSP_PROD）无自动化回归覆盖（E2E 未打包模式恒走 CSP_DEV），M3 加测试钩子
- **已知边界**：BQL 查询文本含字面 `{}` 会因 `run_query` 内部 `.format()` 抛错（-32603）；batch 请求不支持；这两项 M3 若需要再扩展
