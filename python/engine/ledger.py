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
