"""parse_file / validate / parse_entries 方法测试。"""
from pathlib import Path

from engine.ledger import parse_entries, parse_file, validate

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


def test_parse_entries_transaction_structure():
    result = parse_entries(MAIN)
    assert result["errors"] == []
    transactions = [e for e in result["entries"] if e["type"] == "Transaction"]
    assert len(transactions) == 2
    first = transactions[0]
    assert first["date"] == "2026-01-02"
    assert first["flag"] == "*"
    assert first["payee"] is None
    assert first["narration"] == "Breakfast"  # beancount v3：日期行单字符串视为 narration（实测）
    assert isinstance(first["lineno"], int)
    assert first["postings"] == [
        {"account": "Assets:Bank:CNB", "units_number": "-15.00",
         "units_currency": "CNY", "cost_number": None, "cost_currency": None},
        {"account": "Expenses:Food", "units_number": "15.00",
         "units_currency": "CNY", "cost_number": None, "cost_currency": None},
    ]


def test_parse_entries_open_entry_has_account():
    result = parse_entries(MAIN)
    open_entries = [e for e in result["entries"] if e["type"] == "Open"]
    assert len(open_entries) == 3
    assert open_entries[0]["account"] == "Assets:Bank:CNB"
    assert "postings" not in open_entries[0]


def test_parse_entries_bad_ledger_keeps_errors():
    result = parse_entries(BAD)
    assert len(result["errors"]) == 1
    assert result["errors"][0]["type"] == "ValidationError"
