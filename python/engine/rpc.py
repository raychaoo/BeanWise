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
    "shutdown": _shutdown,
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
