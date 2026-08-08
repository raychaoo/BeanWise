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
