---
name: oni-cli
description: Use this skill when working with the ONI newsletter ingest repo, operating ONI poller namespaces, or helping agents read ONI poller databases. It documents the intentionally small ONI CLI surface, the namespace/poller model, and the direct SQLite contract for agent access.
---

# ONI CLI

ONI is an ingestion service. The CLI is intentionally small and should not expose internal pipeline stages.

## Vocabulary

- **Namespace**: a top-level directory under `~/.oni/pollers/<namespace>/`. One namespace owns one DB, one prompt, one schema, one systemd timer.
- **Poller**: an individual Gmail source (one entry in `sources.yaml`) inside a namespace. A namespace can have many pollers; they share the namespace's prompt, schema, DB, and timer.

Group newsletters under one namespace when you want them parsed by the same prompt and stored in the same table — e.g. multiple "things to do in NYC" newsletters. Use a different namespace when the schema or prompt should differ (e.g. `deals`, `civic-meetings`).

## Commands

Use only these commands:

```sh
oni --help
oni --version
oni init <namespace> [options]
oni update <namespace> key=value [...]
oni add-poller <namespace> <poller> --query <gmail-query> [--query ...] [--description <text>] [--parser <key>]
oni start [namespace] [--all]
oni status [namespace] [--json] [-w]
oni query <namespace> [--where field=value] [--limit <n>] [--from <iso>] [--to <iso>] [--source <name>] [--neighborhood <name>] [--order-by <field>]
oni search <namespace> <query> [--limit <n>]
oni logs <namespace> [-f] [-n <lines>]
```

Do not use or recreate low-level CLI verbs such as `poll`, `parse`, `run`, `index`, `schema`, `sources`, or `stop`. Those stages are implementation details.

`oni <namespace> add poller <poller> ...` is accepted as an alias for `oni add-poller <namespace> <poller> ...` so the CLI reads naturally either way.

## Namespace Lifecycle

Create a namespace:

```sh
oni init weekend-nyc \
  --interval-minutes 60 \
  --openclaw-env /path/to/openclaw.env \
  --analyzer-provider anthropic \
  --parsing-prompt "Extract NYC weekend ideas as JSON." \
  --record-name event \
  --table events \
  --root-key events \
  --semantic-provider transformers \
  --semantic-model Xenova/all-MiniLM-L6-v2 \
  --semantic-dimensions 384
```

Add a poller (Gmail source) to the namespace:

```sh
oni add-poller weekend-nyc coolstuffnyc \
  --query 'from:coolstuffnyc@substack.com' \
  --description "Cool Stuff NYC weekly newsletter"

oni add-poller weekend-nyc moma \
  --query 'from:newsletters@email.moma.org' \
  --description "MoMA newsletter"
```

Pass `--query` multiple times to OR several Gmail queries into one poller.

Update only fields that are changing:

```sh
oni update weekend-nyc parsing-prompt="Extract NYC weekend ideas as JSON."
oni update weekend-nyc interval-minutes=15
oni update weekend-nyc semantic-model=Xenova/all-MiniLM-L6-v2 semantic-dimensions=384
oni update weekend-nyc record-name=event table=events root-key=events
```

Start one namespace or all of them:

```sh
oni start weekend-nyc
oni start --all
```

`oni start` (re)writes the systemd unit each time. Re-run it after upgrading the `oni` package so the unit's `ExecStart` points at the current worker.

Read records:

```sh
oni query weekend-nyc --where neighborhood="Fort Greene" --limit 20
oni search weekend-nyc "free outdoor music for families" --limit 10
```

## Health: `oni status`

`oni status` is the primary tool for an agent or operator to confirm ingestion is healthy. Always prefer the JSON form when calling from another agent:

```sh
oni status                  # all namespaces, human-readable
oni status weekend-nyc      # one namespace, human-readable
oni status weekend-nyc -w   # refresh every second
oni status --json           # all namespaces, JSON array
oni status weekend-nyc --json
```

The structured payload is:

```jsonc
{
  "namespace": "weekend-nyc",
  "health": "ok",            // "ok" | "warn" | "error"
  "notes": [],               // human-readable hints, one per detected issue
  "interval_minutes": 60,
  "timer": {
    "state": "active",       // "active" | "inactive" | "failed" | "not-installed" | ...
    "next_run_at": "2026-05-03T15:03:14.000Z",
    "last_run_at": "2026-05-03T14:03:14.000Z"
  },
  "service": {
    "state": "inactive",     // oneshot — "inactive" between runs is normal
    "last_result": "success",
    "last_exit_code": 0,
    "last_started_at": "2026-05-03T14:03:14.000Z",
    "last_finished_at": "2026-05-03T14:03:20.000Z"
  },
  "pipeline": {
    "emails": 5,
    "pending": 0,
    "failed": 0,
    "records": 12,
    "embedded": 12
  },
  "pollers": [
    {
      "name": "coolstuffnyc",
      "configured": true,
      "enabled": true,
      "queries": ["from:coolstuffnyc@substack.com"],
      "description": "Cool Stuff NYC weekly newsletter",
      "emails": 3,
      "failed": 0,
      "last_fetched_at": "2026-05-03T14:03:18.000Z",
      "last_subject": "Welcome to coolstuff.nyc",
      "last_error": null
    }
  ]
}
```

Health rules:
- **error**: timer not installed/active, or last service run reported a non-success result.
- **warn**: any email failed to parse, an unconfigured "orphan" source has emails in the DB, or a configured poller has zero emails after at least one timer run (suggests a wrong `gmail_query`).
- **ok**: nothing else flagged.

When `health != "ok"`, the `notes` array points at the specific fix.

## Pipeline Contract

A running poller cycle is:

```text
Gmail sources -> emails table -> analyzer/parser -> configured output table -> semantic index
```

The operator should not manually prod individual stages. If ingestion is not working, inspect `oni status --json`, `oni logs <namespace>`, and the namespace config files.

Systemd invokes the internal worker file generated by the build (`dist/worker.js`). Do not add hidden CLI commands or flags for worker-only behavior.

## Namespace Files

By default, namespaces live under:

```text
~/.oni/pollers/<namespace>/
  poller.yaml      # interval, provider, model, DB path, semantic model, env file
  sources.yaml     # one entry per Gmail poller in this namespace
  prompt.md        # analyzer instructions (shared by all pollers in the namespace)
  schema.yaml      # output table name, root key, and custom columns
  newsletters.db   # SQLite (emails + configured output table + semantic index)
  logs/
```

Use `ONI_HOME` or `oni --home <path>` when the home directory is not the default.

Edit files directly for rich configuration:

- `sources.yaml`: append entries by hand, or use `oni add-poller`. Each entry can specify either `gmail_query: "..."` (single) or `gmail_queries: ["...", "..."]` (multiple, OR'd together).
- `prompt.md`: analyzer instructions. Keep it source-neutral when the namespace mixes multiple newsletters.
- `schema.yaml`: change to extract any kind of structured record, not just events.
- `poller.yaml`: interval, provider, model, DB path, semantic model, and `openclaw_env` path.

## Agent Data Access

Agents should prefer `oni query` for exact structured reads, `oni search` for semantic reads, and `oni status --json` for health checks. Direct SQLite access is acceptable when an agent needs custom joins or bulk reads.

To discover a namespace:

1. Resolve ONI home from `ONI_HOME`, `--home`, or `~/.oni`.
2. Read `pollers/<namespace>/poller.yaml`.
3. Resolve the DB path from `database.path`, relative to the namespace directory unless absolute.
4. Read `schema.yaml` to find the configured output `table`, `root_key`, and columns.
5. Open `newsletters.db` read-only.

Every output table has:

```text
id, email_id, source, raw_json, extracted_at
```

plus the custom columns from `schema.yaml`. The raw emails are in `emails`. The `source` column matches the `name` of the poller in `sources.yaml`, so agents can filter records to a specific newsletter.

Useful status queries:

```sql
SELECT COUNT(*) FROM emails;
SELECT COUNT(*) FROM emails WHERE parsed_at IS NULL;
SELECT COUNT(*) FROM emails WHERE parse_error IS NOT NULL;
SELECT source, COUNT(*) FROM emails GROUP BY source;
SELECT COUNT(*) FROM "<output_table>";
```

For exact structured reads, `oni query` filters the configured output table. For semantic retrieval, `oni search` embeds the query text with the configured embedding model and compares it against vectors stored in SQLite.

## Design Rule

Keep `oni` boring: initialize, add pollers, update, start, inspect status, read logs, and retrieve records. Do not expose pipeline-stage controls as CLI commands.
