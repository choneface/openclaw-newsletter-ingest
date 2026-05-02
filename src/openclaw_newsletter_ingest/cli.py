"""nli — newsletter ingestion CLI.

Subcommands:
    nli init-db                        Create tables.
    nli sources                        List configured sources.
    nli poll [--source NAME] [--limit N]
                                       Fetch new emails matching each source.
    nli parse [--limit N] [--retry-failed]
                                       Run Claude on unparsed emails, write events.
    nli run                            poll + parse, for cron.
    nli query [--from D] [--to D] [--source S] [--neighborhood N] [--limit N]
                                       Read events as JSON.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from .config import load_settings, load_sources
from . import db as dbm
from . import poller
from . import parser as ai_parser


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


def cmd_init_db(_args: argparse.Namespace) -> int:
    settings = load_settings()
    dbm.init_db(settings.db_path)
    print(f"initialized {settings.db_path}")
    return 0


def cmd_sources(_args: argparse.Namespace) -> int:
    sources = load_sources()
    for s in sources:
        print(f"{s.name:20s} {s.parser:25s} {s.gmail_query}")
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    settings = load_settings()
    sources = load_sources()
    if args.source:
        sources = [s for s in sources if s.name == args.source]
        if not sources:
            print(f"no source named {args.source}", file=sys.stderr)
            return 2
    results = poller.poll_all(settings, sources, limit=args.limit)
    for r in results:
        print(f"{r.source}: fetched={r.fetched} new={r.new}")
    return 0


def cmd_parse(args: argparse.Namespace) -> int:
    settings = load_settings()
    parsed = 0
    failed = 0
    with dbm.connect(settings.db_path) as conn:
        rows = dbm.unparsed_emails(conn, limit=args.limit)
        for row in rows:
            try:
                events = ai_parser.extract_events(settings, row["raw_text"] or "")
                n = dbm.insert_events(conn, row["id"], row["source"], events)
                dbm.mark_email_parsed(conn, row["id"], error=None)
                parsed += 1
                print(f"  email#{row['id']} ({row['source']}): {n} events")
            except Exception as e:  # noqa: BLE001 — record and continue
                dbm.mark_email_parsed(conn, row["id"], error=str(e))
                failed += 1
                print(f"  email#{row['id']} FAILED: {e}", file=sys.stderr)
    print(f"parsed={parsed} failed={failed}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    rc = cmd_poll(args)
    if rc != 0:
        return rc
    return cmd_parse(args)


def cmd_query(args: argparse.Namespace) -> int:
    settings = load_settings()
    with dbm.connect(settings.db_path) as conn:
        rows = dbm.query_events(
            conn,
            date_from=args.date_from,
            date_to=args.date_to,
            source=args.source,
            neighborhood=args.neighborhood,
            limit=args.limit,
        )
    json.dump(rows, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="nli")
    p.add_argument("--log-level", default=None)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init-db").set_defaults(func=cmd_init_db)
    sub.add_parser("sources").set_defaults(func=cmd_sources)

    p_poll = sub.add_parser("poll")
    p_poll.add_argument("--source")
    p_poll.add_argument("--limit", type=int, default=None)
    p_poll.set_defaults(func=cmd_poll)

    p_parse = sub.add_parser("parse")
    p_parse.add_argument("--limit", type=int, default=None)
    p_parse.set_defaults(func=cmd_parse)

    p_run = sub.add_parser("run")
    p_run.add_argument("--source")
    p_run.add_argument("--limit", type=int, default=None)
    p_run.set_defaults(func=cmd_run)

    p_query = sub.add_parser("query")
    p_query.add_argument("--from", dest="date_from")
    p_query.add_argument("--to", dest="date_to")
    p_query.add_argument("--source")
    p_query.add_argument("--neighborhood")
    p_query.add_argument("--limit", type=int, default=100)
    p_query.set_defaults(func=cmd_query)

    args = p.parse_args(argv)

    # Logging level: CLI flag > .env > default.
    try:
        env_level = load_settings().log_level
    except Exception:
        env_level = "INFO"
    _setup_logging(args.log_level or env_level)

    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
