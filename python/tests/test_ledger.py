"""parse_file / validate / parse_entries 方法测试。"""
from pathlib import Path

from engine.ledger import parse_entries, parse_file, validate

FIXTURES = Path(__file__).parent / "fixtures"
MAIN = str(FIXTURES / "main.beancount")
BAD = str(FIXTURES / "bad.beancount")
MISSING = str(FIXTURES / "missing.beancount")
COUNTERPARTY = str(FIXTURES / "counterparty.beancount")
LOANS = str(FIXTURES / "loans.beancount")


def _tx(result, narration):
    """按 narration 取出交易（fixture 内 narration 唯一）。"""
    return next(
        e for e in result["entries"]
        if e["type"] == "Transaction" and e["narration"] == narration
    )


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
         "units_currency": "CNY", "cost_number": None, "cost_currency": None,
         "counterparty": None},
        {"account": "Expenses:Food", "units_number": "15.00",
         "units_currency": "CNY", "cost_number": None, "cost_currency": None,
         "counterparty": None},
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


# --- 往来对象 counterparty（ADR 23）---

def test_parse_entries_counterparty_posting_level():
    """posting 级 metadata 优先：只有挂了 metadata 的那条分录带 counterparty。"""
    tx = _tx(parse_entries(COUNTERPARTY), "转账汇款")
    assert tx["postings"] == [
        {"account": "Assets:Receivables:Lend", "units_number": "20000.00",
         "units_currency": "CNY", "cost_number": None, "cost_currency": None,
         "counterparty": "李素珍"},
        {"account": "Assets:Bank:ZSYH", "units_number": "-20000.00",
         "units_currency": "CNY", "cost_number": None, "cost_currency": None,
         "counterparty": None},
    ]


def test_parse_entries_counterparty_transaction_level_fallback():
    """transaction 级 metadata 回退：该笔所有分录都带上同一个对象。"""
    tx = _tx(parse_entries(COUNTERPARTY), "快捷支付")
    assert [p["counterparty"] for p in tx["postings"]] == ["李志全", "李志全"]


def test_parse_entries_counterparty_absent_is_none():
    """无 counterparty 的交易（非往来类）→ 所有分录为 None，不臆造值。"""
    tx = _tx(parse_entries(COUNTERPARTY), "买菜")
    assert [p["counterparty"] for p in tx["postings"]] == [None, None]


# --- 贷款核销 link（ADR 23 P2）---

def test_parse_entries_transaction_links():
    """交易级 link 透出为排序后的 list；无 link → 空 list（不是 None）。"""
    result = parse_entries(LOANS)
    assert result["errors"] == []
    txs = {e["narration"]: e for e in result["entries"] if e["type"] == "Transaction"}
    assert txs["借出5000"]["links"] == ["lend-aaa"]
    # 还款笔挂的是它所结清的贷款 ID（与借出笔同一个值）
    assert txs["还4000"]["links"] == ["lend-aaa"]
    assert txs["再借3000"]["links"] == ["lend-bbb"]
    assert txs["借出800"]["links"] == []
