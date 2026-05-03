#!/usr/bin/env sh
set -eu

slug="${POLLER_SLUG:-docker-test}"
interval="${INTERVAL_MINUTES:-30}"
openclaw_env="${OPENCLAW_ENV_IN_CONTAINER:-/run/secrets/openclaw.env}"
analyzer_provider="${ANALYZER_PROVIDER:-mock}"

oni init "$slug" \
  --force \
  --interval-minutes "$interval" \
  --analyzer-provider "$analyzer_provider" \
  --openclaw-env "$openclaw_env"
