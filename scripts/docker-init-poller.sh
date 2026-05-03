#!/usr/bin/env sh
set -eu

slug="${POLLER_SLUG:-docker-test}"
interval="${INTERVAL_MINUTES:-30}"
openclaw_env="${OPENCLAW_ENV_IN_CONTAINER:-/run/secrets/openclaw.env}"
analyzer_provider="${ANALYZER_PROVIDER:-mock}"
spec="/tmp/${slug}.spec.yaml"

cat > "$spec" <<EOF
namespace: $slug
interval_minutes: $interval
openclaw_env: $openclaw_env
analyzer:
  provider: $analyzer_provider
prompt: |
  You extract NYC events from newsletter emails.

  Return a JSON object with an "events" array. If the email contains no actual
  events, return {"events": []}.
schema:
  record_name: event
  table: events
  root_key: events
  columns:
    - name: name
      type: text
      required: true
    - name: date
      type: text
      index: true
    - name: link
      type: text
    - name: blurb
      type: text
pollers:
  - name: _self_test
    gmail_query: 'subject:"[oni-test]"'
EOF

oni init "$spec" --force
