"""Load .env and sources.yaml."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml
from dotenv import load_dotenv


REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    gmail_user: str
    gmail_app_password: str
    gmail_folder: str
    anthropic_api_key: str
    claude_model: str
    db_path: Path
    log_level: str


@dataclass(frozen=True)
class Source:
    name: str
    description: str
    gmail_query: str
    parser: str
    enabled: bool


def load_settings() -> Settings:
    load_dotenv(REPO_ROOT / ".env", override=False)

    # Fall back to the openclaw .env for shared secrets (notably ANTHROPIC_API_KEY).
    # On the VPS this means we don't duplicate the key — when openclaw rotates it,
    # newsletter-ingest picks up the new value on next run.
    openclaw_env = os.environ.get("OPENCLAW_ENV")
    if openclaw_env and Path(openclaw_env).is_file():
        load_dotenv(openclaw_env, override=False)

    def req(key: str) -> str:
        v = os.environ.get(key)
        if not v:
            raise RuntimeError(f"{key} is not set (check .env or OPENCLAW_ENV)")
        return v

    return Settings(
        gmail_user=req("GMAIL_USER"),
        gmail_app_password=req("GMAIL_APP_PASSWORD").replace(" ", ""),
        gmail_folder=os.environ.get("GMAIL_FOLDER", "INBOX"),
        anthropic_api_key=req("ANTHROPIC_API_KEY"),
        claude_model=os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6"),
        db_path=Path(req("DB_PATH")),
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
    )


def load_sources(path: Path | None = None) -> list[Source]:
    p = path or (REPO_ROOT / "sources.yaml")
    raw = yaml.safe_load(p.read_text())
    return [
        Source(
            name=entry["name"],
            description=entry.get("description", ""),
            gmail_query=entry["gmail_query"],
            parser=entry.get("parser", "default_event_extractor"),
            enabled=entry.get("enabled", True),
        )
        for entry in raw
        if entry.get("enabled", True)
    ]
