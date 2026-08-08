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
    dcontext = options.get("dcontext")
    if dcontext is None:
        raise QueryError("beancount 加载结果缺少 dcontext，options 结构异常（可能是 beancount 版本变更）")
    if fmt == "csv":
        render_csv(result_types, result_rows, dcontext, out)
    else:
        render_text(result_types, result_rows, dcontext, out, unicode=False)
    return {"text": out.getvalue(), "errors": _serialize_errors(errors)}
