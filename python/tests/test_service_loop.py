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
