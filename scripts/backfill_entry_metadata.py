#!/usr/bin/env python3
"""Backfill stable transaction metadata (`id/time`) into a Beancount file.

The reference ledger is optional. Transactions are matched by their header plus
posting lines, ignoring metadata so an already-enriched reference can annotate
an older ledger. Existing id/time values are preserved.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence


TX_HEADER_RE = r"^\d{4}-\d{2}-\d{2}\s+[*!](?:\s|$)"
ID_RE = r'^\s+id:\s*"([A-Za-z0-9_-]+)"\s*$'
TIME_RE = r'^\s+time:\s*"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"\s*$'
POSTING_RE = r"^\s+[A-Z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)+\s+"


def _transaction_blocks(lines: Sequence[str]) -> list[tuple[int, int]]:
    blocks: list[tuple[int, int]] = []
    i = 0
    while i < len(lines):
        if not re.match(TX_HEADER_RE, lines[i]):
            i += 1
            continue
        end = i + 1
        while end < len(lines) and lines[end].strip() != "" and lines[end].startswith((" ", "\t")):
            end += 1
        blocks.append((i, end))
        i = end
    return blocks


def _transaction_key(block: Sequence[str]) -> str:
    return "\n".join([block[0], *[line for line in block[1:] if re.match(POSTING_RE, line)]])


def _extract_meta(block: Sequence[str]) -> tuple[str | None, str | None]:
    tx_id = None
    tx_time = None
    for line in block[1:]:
        match = re.match(ID_RE, line)
        if match:
            tx_id = match.group(1)
            continue
        match = re.match(TIME_RE, line)
        if match:
            tx_time = match.group(1)
    return tx_id, tx_time


def stable_entry_id(header: str, posting_lines: Sequence[str], occurrence: int) -> str:
    payload = json.dumps([header, list(posting_lines), occurrence], ensure_ascii=False, separators=(",", ":"))
    return "bw-" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _fallback_time(date: str) -> str:
    datetime.strptime(date, "%Y-%m-%d")
    return f"{date} 00:00:00"


def inject_entry_metadata(
    target_lines: Sequence[str], reference_lines: Sequence[str]
) -> tuple[list[str], dict[str, int]]:
    ref_queues: dict[str, list[tuple[str | None, str | None]]] = defaultdict(list)
    for start, end in _transaction_blocks(reference_lines):
        block = reference_lines[start:end]
        tx_id, tx_time = _extract_meta(block)
        if tx_id or tx_time:
            ref_queues[_transaction_key(block)].append((tx_id, tx_time))

    out: list[str] = []
    stats = {"total": 0, "reused": 0, "generated": 0, "existing": 0}
    occurrences: Counter[str] = Counter()
    used_ids: set[str] = set()
    cursor = 0
    for start, end in _transaction_blocks(target_lines):
        out.extend(target_lines[cursor:start])
        block = list(target_lines[start:end])
        tx_id, tx_time = _extract_meta(block)
        original_id, original_time = tx_id, tx_time
        stats["total"] += 1
        if tx_id and tx_time:
            stats["existing"] += 1

        if not tx_id or not tx_time:
            key = _transaction_key(block)
            queue = ref_queues.get(key)
            if queue:
                ref_id, ref_time = queue.pop(0)
                tx_id = tx_id or ref_id
                tx_time = tx_time or ref_time
                if ref_id or ref_time:
                    stats["reused"] += 1

        if not tx_id or not tx_time:
            occurrences[_transaction_key(block)] += 1
            occurrence = occurrences[_transaction_key(block)]
            posting_lines = [line for line in block[1:] if re.match(POSTING_RE, line)]
            if not tx_id:
                tx_id = stable_entry_id(block[0], posting_lines, occurrence)
            if not tx_time:
                tx_time = _fallback_time(block[0][:10])
            if tx_id != original_id or tx_time != original_time:
                stats["generated"] += 1

        if tx_id in used_ids:
            raise ValueError(f"duplicate generated transaction id: {tx_id}")
        used_ids.add(tx_id)

        out.append(block[0])
        if not original_id:
            out.append(f'  id: "{tx_id}"')
        if not original_time:
            out.append(f'  time: "{tx_time}"')
        out.extend(block[1:])
        cursor = end
    out.extend(target_lines[cursor:])
    return out, stats


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="target Beancount ledger")
    parser.add_argument("--reference", type=Path, help="optional enriched reference ledger")
    parser.add_argument("--apply", action="store_true", help="write changes after validation")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    target_lines = args.target.read_text(encoding="utf-8").split("\n")
    reference_lines = (
        args.reference.read_text(encoding="utf-8").split("\n") if args.reference is not None else []
    )
    updated, stats = inject_entry_metadata(target_lines, reference_lines)
    print(
        f"transactions={stats['total']} reused={stats['reused']} "
        f"generated={stats['generated']} existing={stats['existing']}"
    )
    if not args.apply:
        print("dry-run: no files changed")
        return 0

    from beancount import loader

    backup = args.target.with_name(args.target.name + ".bak_entry_metadata")
    shutil.copy2(args.target, backup)
    tmp = args.target.with_name(args.target.name + ".tmp")
    tmp.write_text("\n".join(updated), encoding="utf-8")
    _entries, errors, _options = loader.load_file(str(tmp))
    if errors:
        tmp.unlink(missing_ok=True)
        print(f"validation failed: {len(errors)} errors; backup retained at {backup}")
        return 1
    tmp.replace(args.target)
    print(f"applied: {args.target} (backup: {backup})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
