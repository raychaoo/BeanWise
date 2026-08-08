#!/usr/bin/env python3
"""BeanWise Beancount 引擎 —— stdio JSON-RPC 2.0 服务。

协议（roadmap「Node ↔ Python」）：JSONL 逐行（每行一个 JSON-RPC 请求，\n 分隔）；
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
