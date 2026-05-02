#!/usr/bin/env bash
# Bootstrap ONI from a local checkout. For normal use prefer:
#   npm install -g @choneface/oni

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> installing deps"
npm install
npm run build
npm link

echo
echo "Install complete."
echo "  CLI: oni"
echo "Next:"
echo "  oni init weekendercrix --openclaw-env /docker/openclaw-874u/.env"
