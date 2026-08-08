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
