from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "backfill_entry_metadata.py"
spec = importlib.util.spec_from_file_location("backfill_entry_metadata", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def _block(header: str, *, tx_id: str | None = None, time: str | None = None) -> list[str]:
    lines = [header]
    if tx_id:
        lines.append(f'  id: "{tx_id}"')
    if time:
        lines.append(f'  time: "{time}"')
    lines.extend(
        [
            "  Expenses:Food  10.00 CNY",
            "  Assets:Cash  -10.00 CNY",
            "",
        ]
    )
    return lines


def test_inject_metadata_reuses_reference_id_and_time():
    reference = _block(
        '2026-01-02 * "Cafe" "breakfast"',
        tx_id="bw-reference",
        time="2026-01-02 08:30:15",
    )
    target = _block('2026-01-02 * "Cafe" "breakfast"')

    updated, stats = module.inject_entry_metadata(target, reference)

    assert updated == _block(
        '2026-01-02 * "Cafe" "breakfast"',
        tx_id="bw-reference",
        time="2026-01-02 08:30:15",
    )
    assert stats == {"total": 1, "reused": 1, "generated": 0, "existing": 0}


def test_inject_metadata_generates_stable_id_and_date_fallback_for_unmatched():
    target = _block('2026-01-03 * "Coffee" "late"')

    first, stats = module.inject_entry_metadata(target, [])
    second, _ = module.inject_entry_metadata(target, [])

    assert first == second
    assert first[1] == f'  id: "{module.stable_entry_id(target[0], [target[1], target[2]], 1)}"'
    assert first[2] == '  time: "2026-01-03 00:00:00"'
    assert stats == {"total": 1, "reused": 0, "generated": 1, "existing": 0}


def test_inject_metadata_preserves_existing_metadata():
    target = _block(
        '2026-01-04 * "Tea" "keep"',
        tx_id="bw-existing",
        time="2026-01-04 10:11:12",
    )

    updated, stats = module.inject_entry_metadata(target, [])

    assert updated == target
    assert stats == {"total": 1, "reused": 0, "generated": 0, "existing": 1}
