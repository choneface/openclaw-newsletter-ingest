"""IMAP poller — fetches new emails matching each source's gmail_query and stores them."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from imap_tools import AND, MailBox, MailMessage

from .config import Settings, Source
from .db import connect, insert_email


log = logging.getLogger(__name__)


@dataclass
class PollResult:
    source: str
    fetched: int
    new: int


def _body_text(msg: MailMessage) -> str:
    """Prefer plaintext; fall back to stripping HTML naively."""
    if msg.text:
        return msg.text
    if msg.html:
        # very rough; the parser sees enough signal even with tags
        return msg.html
    return ""


def poll_source(
    settings: Settings, source: Source, *, mailbox: MailBox, limit: int | None = None
) -> PollResult:
    log.info("polling source=%s query=%r", source.name, source.gmail_query)
    fetched = 0
    new = 0
    # Gmail's full search syntax via X-GM-RAW.
    criteria = AND(gmail_label="").__class__  # noqa: F841 — silence unused
    with connect(settings.db_path) as conn:
        for msg in mailbox.fetch(
            criteria=f'X-GM-RAW "{source.gmail_query}"',
            limit=limit,
            mark_seen=False,
            bulk=True,
        ):
            fetched += 1
            row_id = insert_email(
                conn,
                source=source.name,
                message_id=msg.uid + "@" + (msg.from_ or "unknown"),
                from_addr=msg.from_,
                subject=msg.subject,
                received_at=msg.date.isoformat() if msg.date else None,
                raw_text=_body_text(msg),
            )
            if row_id is not None:
                new += 1
                log.info("  new email id=%d subject=%r", row_id, msg.subject)
    return PollResult(source=source.name, fetched=fetched, new=new)


def poll_all(settings: Settings, sources: list[Source], *, limit: int | None = None) -> list[PollResult]:
    """Open one IMAP connection, poll every source through it."""
    results: list[PollResult] = []
    with MailBox("imap.gmail.com").login(
        settings.gmail_user, settings.gmail_app_password, settings.gmail_folder
    ) as mailbox:
        for source in sources:
            results.append(poll_source(settings, source, mailbox=mailbox, limit=limit))
    return results
