"""SQLite schema + helpers."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema.sql"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect(db_path: Path) -> Iterator[sqlite3.Connection]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path: Path) -> None:
    with connect(db_path) as conn:
        conn.executescript(SCHEMA_PATH.read_text())


def insert_email(
    conn: sqlite3.Connection,
    *,
    source: str,
    message_id: str,
    from_addr: str | None,
    subject: str | None,
    received_at: str | None,
    raw_text: str,
) -> int | None:
    """Insert email; return new row id, or None if message_id already exists."""
    try:
        cur = conn.execute(
            """INSERT INTO emails
               (source, message_id, from_addr, subject, received_at, raw_text, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (source, message_id, from_addr, subject, received_at, raw_text, now_iso()),
        )
        return cur.lastrowid
    except sqlite3.IntegrityError:
        return None  # duplicate message_id


def unparsed_emails(conn: sqlite3.Connection, limit: int | None = None) -> list[sqlite3.Row]:
    sql = "SELECT * FROM emails WHERE parsed_at IS NULL ORDER BY id"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return list(conn.execute(sql))


def mark_email_parsed(conn: sqlite3.Connection, email_id: int, error: str | None = None) -> None:
    conn.execute(
        "UPDATE emails SET parsed_at = ?, parse_error = ? WHERE id = ?",
        (now_iso(), error, email_id),
    )


def insert_events(conn: sqlite3.Connection, email_id: int, source: str, events: list[dict[str, Any]]) -> int:
    if not events:
        return 0
    ts = now_iso()
    rows = [
        (
            email_id,
            source,
            e.get("name") or "(unnamed)",
            e.get("date"),
            e.get("end_date"),
            e.get("time"),
            e.get("location"),
            e.get("neighborhood"),
            e.get("price"),
            e.get("link"),
            e.get("blurb"),
            json.dumps(e.get("tags") or []),
            ts,
        )
        for e in events
    ]
    conn.executemany(
        """INSERT INTO events
           (email_id, source, name, date, end_date, time, location,
            neighborhood, price, link, blurb, tags_json, extracted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    return len(rows)


def query_events(
    conn: sqlite3.Connection,
    *,
    date_from: str | None = None,
    date_to: str | None = None,
    source: str | None = None,
    neighborhood: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    where = []
    params: list[Any] = []
    if date_from:
        where.append("date >= ?"); params.append(date_from)
    if date_to:
        where.append("date <= ?"); params.append(date_to)
    if source:
        where.append("source = ?"); params.append(source)
    if neighborhood:
        where.append("neighborhood = ?"); params.append(neighborhood)
    sql = "SELECT * FROM events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY date NULLS LAST, id LIMIT ?"
    params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params)]
