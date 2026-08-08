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
