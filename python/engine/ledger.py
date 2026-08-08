"""Beancount 文件加载 / 校验封装。

说明：load_file 的管线（beancount.loader._load）已包含 booking 与
beancount.ops.validation.validate（v3 实测：未配平交易在 load errors 中即报
ValidationError）。因此 validate 与 parse_file 共享同一加载管线，返回的全量
错误列表（解析 + 记账 + 校验）完全一致——M3 校验流程可任选其一，或两者都调做冗余。
"""
from beancount import loader
from beancount.core.data import Open, Transaction


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


def _serialize_entry(entry) -> dict:
    """把 beancount entry 转成 JSON 友好 dict（M3 SQLite 索引数据源）。

    扁平结构：通用字段（type/date/lineno）+ 类型专属字段（Transaction 的
    postings、Open 的 account），其余类型只带通用字段。金额 Decimal 一律
    str() 保持精度（与 M2 协议一致）。
    """
    item = {
        "type": type(entry).__name__,
        "date": entry.date.isoformat(),
        "lineno": entry.meta.get("lineno") if isinstance(entry.meta, dict) else None,
    }
    if isinstance(entry, Transaction):
        item["flag"] = entry.flag
        item["payee"] = entry.payee
        item["narration"] = entry.narration
        item["postings"] = [
            {
                "account": p.account,
                "units_number": str(p.units.number),
                "units_currency": p.units.currency,
                "cost_number": str(p.cost.number) if p.cost else None,
                "cost_currency": p.cost.currency if p.cost else None,
            }
            for p in entry.postings
        ]
    elif isinstance(entry, Open):
        item["account"] = entry.account
    return item


def parse_entries(filename: str) -> dict:
    """解析文件，返回条目明细 + 错误列表 + options（M3 SQLite 索引数据源）。"""
    entries, errors, options = loader.load_file(filename)
    return {
        "entries": [_serialize_entry(e) for e in entries],
        "errors": _serialize_errors(errors),
        "options": _serialize_options(options),
    }
