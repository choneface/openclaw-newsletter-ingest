#!/usr/bin/env bash
# Bootstrap newsletter-ingest on the VPS. Idempotent — safe to re-run.
#
# Assumes:
#   - Cloned to /opt/openclaw-newsletter-ingest
#   - Python 3.10+ with `venv` available
#   - The openclaw stack is at /docker/openclaw-874u (so we can source its .env)
#
# Run: bash scripts/install.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> creating venv"
python3 -m venv .venv

echo "==> installing deps"
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -e .

if [[ ! -f .env ]]; then
  echo "==> seeding .env from .env.example"
  cp .env.example .env
  echo "    ! edit $REPO_DIR/.env to set GMAIL_USER and GMAIL_APP_PASSWORD"
fi

echo "==> initializing db"
.venv/bin/nli init-db

echo
echo "Install complete."
echo "  CLI:    $REPO_DIR/.venv/bin/nli"
echo "  Config: $REPO_DIR/.env"
echo
echo "Next: set GMAIL_USER + GMAIL_APP_PASSWORD in .env, then:"
echo "  $REPO_DIR/.venv/bin/nli sources"
echo "  $REPO_DIR/.venv/bin/nli run"
