# oni

OpenClaw Newsletter Ingest: poll Gmail newsletters, analyze them with an LLM,
and store configurable structured records in SQLite for OpenClaw agents to
query.

## Architecture

```
   systemd timer
        │
        ▼
   oni start <slug>
   └── systemd timer runs the poller cycle:
       poll → parse → index
        │
        ▼
   SQLite in ~/.oni/pollers/<slug>/newsletters.db
        │
        ▼
   OpenClaw agents read SQLite directly
```

An ONI namespace is the thing agents query later, such as `ai-news`,
`nyc-events`, or `founder-updates`. Each namespace has one database, one output
schema, one parsing prompt, and one schedule. Inside a namespace, you can add
many named newsletter pollers. Each poller tracks one source and can use one or
more Gmail queries to find matching emails.

Code runs on the VPS host as a Node CLI installed with npm.

## Install

ONI requires Node 20 or newer. The install may appear to work on Node 18, but
current transitive logging dependencies declare Node 20 as their supported
runtime.

```sh
npm install -g @choneface/oni
```

For local development:

```sh
npm install
npm run build
npm test
```

## Create A Namespace

Create a shareable namespace spec:

```yaml
namespace: newsletter-demo
interval_minutes: 30
openclaw_env: /path/to/openclaw.env
prompt: |
  Extract NYC events as JSON.
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
pollers:
  - name: timeout-nyc
    description: TimeOut NYC weekly picks
    gmail_query: from:newsletter@timeout.com
```

Then initialize from the spec:

```sh
oni init newsletter-demo.spec.yaml
```

This creates:

```text
~/.oni/
  config.yaml
  pollers/
    newsletter-demo/
      poller.yaml
      sources.yaml
      prompt.md
      schema.yaml
      newsletters.db
      logs/
```

Edit `poller.yaml` for model/API/provider settings, `sources.yaml` for Gmail
queries, `prompt.md` for the analyzer instructions, and `schema.yaml` for the
records you want stored.

`oni init` fails if the namespace already exists. To intentionally delete and
rebuild an existing namespace from a spec:

```sh
oni init newsletter-demo.spec.yaml --force
```

`--force` removes the old namespace directory first, including the database,
logs, prompt, schema, and sources.

Supported column types are `text`, `integer`, `number`, `boolean`, and `json`.
ONI always adds `id`, `email_id`, `source`, `raw_json`, and `extracted_at`.

Specs can include analyzer and semantic settings:

```yaml
analyzer:
  provider: anthropic
  model: claude-sonnet-4-6
semantic:
  provider: transformers
  model: Xenova/all-MiniLM-L6-v2
  dimensions: 384
```

For a different record shape, put the full output schema in the spec:

```yaml
namespace: deals
schema:
  record_name: deal
  table: deals
  root_key: deals
  columns:
    - name: title
      type: text
      required: true
    - name: company
      type: text
      index: true
    - name: discount_percent
      type: integer
    - name: expires_on
      type: text
      index: true
    - name: link
      type: text
    - name: metadata
      type: json
pollers:
  - name: promos
    gmail_query: from:promos@example.com
```

For simple naming/model/prompt changes, update only the fields that are changing:

```sh
oni update deals record-name=deal table=deals root-key=deals
oni update deals semantic-model=Xenova/all-MiniLM-L6-v2 semantic-dimensions=384
oni update deals parsing-prompt="Extract retail deals as JSON."
```

For column changes, edit `schema.yaml`; ONI will initialize the configured table
the next time the poller runs.

## Add Newsletter Pollers

Add each newsletter to the namespace as a named poller:

```sh
oni newsletter-demo add poller timeout-nyc \
  --description "TimeOut NYC weekly picks" \
  --query 'from:newsletter@timeout.com'
```

Use multiple `--query` flags when a newsletter needs more than one Gmail search
to catch the right messages:

```sh
oni ai-news add poller ben-evans \
  --description "Benedict Evans newsletter" \
  --query 'from:newsletter@ben-evans.com' \
  --query 'subject:"Benedict Evans"'
```

This appends entries to `sources.yaml`. You can also edit the file directly:

```yaml
- name: timeout-nyc
  description: TimeOut NYC weekly picks
  gmail_query: 'from:newsletter@timeout.com'   # Gmail search syntax
  parser: default_event_extractor
  enabled: true

- name: ben-evans
  description: Benedict Evans newsletter
  gmail_queries:
    - 'from:newsletter@ben-evans.com'
    - 'subject:"Benedict Evans"'
  parser: default_event_extractor
  enabled: true
```

Run `oni start newsletter-demo` to let systemd run it on the configured interval.

`gmail_query` and `gmail_queries` accept anything Gmail's search bar accepts:
`from:`, `to:`, `subject:`, `label:`, `after:`, `older_than:`, parentheses,
`OR`, `-`. See [Gmail's search reference](https://support.google.com/mail/answer/7190).

## Custom parsing logic

The analyzer uses `prompt.md`, `schema.yaml`, and the source metadata in
`sources.yaml` to extract records. The default prompt is event-oriented, so for
non-event data you should rewrite `prompt.md` to describe the desired records
and edit `schema.yaml` to match. ONI includes the configured output shape in
the model request and expects JSON like:

```json
{
  "deals": [
    {
      "title": "Example sale",
      "company": "Example Co",
      "discount_percent": 25,
      "metadata": { "category": "retail" }
    }
  ]
}
```

If a source needs different extraction behavior from other sources, create a
separate namespace with a tailored `prompt.md`/`schema.yaml` or extend
`src/analyzer.ts` and the `parser` dispatch in `sources.yaml`.

## Agent Skills

The npm package includes agent-facing skills:

- `skills/oni-cli/SKILL.md`: how to operate the intentionally small ONI CLI
  surface.
- `skills/oni-ingestion-service-builder/SKILL.md`: how to interview a user and
  gather the purpose, Gmail source queries, freshness needs, downstream use
  case, parsing prompt notes, and schema fields needed for a namespace spec.

## Optional X/Twitter Signal Handoff

ONI is the durable newsletter ingestion layer. If a downstream OpenClaw agent
also needs public X/Twitter context around the records ONI extracts, install
TweetClaw as a separate OpenClaw plugin:

```sh
openclaw plugins install @xquik/tweetclaw
```

Use ONI to collect and query newsletter records, then use TweetClaw for the
X/Twitter side of the workflow: search tweets, search tweet replies, export
followers, look up users, monitor tweets, deliver webhooks, upload or download
media, send direct messages, run giveaway draws, and post reviewed tweets or
tweet replies after a human approves the final copy.

TweetClaw is published as the npm package
[`@xquik/tweetclaw`](https://www.npmjs.com/package/@xquik/tweetclaw). The
[GitHub repo](https://github.com/Xquik-dev/tweetclaw) has the current
configuration steps, and the
[ClawHub page](https://clawhub.ai/plugins/@xquik/tweetclaw) is useful for
browsing the OpenClaw plugin listing.

## Semantic Search

ONI keeps SQLite as the source of truth and adds an optional local semantic
index for abstract agent retrieval. Use `oni query` for exact structured
filters and `oni search` for meaning-based lookup.

New pollers include:

```yaml
semantic:
  provider: transformers
  model: Xenova/all-MiniLM-L6-v2
  dimensions: 384
```

Each poller cycle refreshes the vector index after parsing.

Search parsed records by concept:

```sh
oni search newsletter-demo "quiet free outdoor music this weekend" --limit 10
```

The first poller cycle with semantic indexing downloads the configured Transformers.js model into
the local Hugging Face cache. The default model is a small open-source embedding
model that runs locally and stores vectors in the same `newsletters.db` using
`sqlite-vec`. Future embedding models can be configured by changing `model` and
`dimensions`; ONI currently supports the local `transformers` provider.

You'll need:
- A Gmail account with **2FA enabled** (required for app passwords)
- An app password from https://myaccount.google.com/apppasswords
- An Anthropic API key

## Run On The VPS

```sh
npm install -g @choneface/oni
oni init newsletter-demo.spec.yaml
oni start newsletter-demo
```

`oni start <slug>` writes a systemd service/timer pair named
`oni-<slug>.service` and `oni-<slug>.timer`.

## Docker Smoke Test

The Compose setup runs the same Node CLI in a Debian container and stores
poller state under `.docker/oni-home` on the host. It references the secrets
file as an env file and read-only mount; do not print it or copy it into the
repo.

```sh
docker compose build oni
docker compose run --rm init-poller
docker compose run --rm --entrypoint node oni dist/worker.js docker-test
docker compose run --rm oni status docker-test
```

`init-poller` uses `ANALYZER_PROVIDER=mock` by default so smoke tests can
verify Gmail polling, storage, and parse bookkeeping without spending LLM
tokens. Set `ANALYZER_PROVIDER=anthropic` when you intentionally want to test
live extraction.

To use a different secrets file or poller slug:

```sh
OPENCLAW_ENV_FILE=/path/to/openclaw.env POLLER_SLUG=newsletter-demo docker compose run --rm init-poller
OPENCLAW_ENV_FILE=/path/to/openclaw.env docker compose run --rm --entrypoint node oni dist/worker.js newsletter-demo
```

## CLI

```
oni --version                            show installed version
oni --help                               show commands
oni init <spec.yaml>                     create a namespace from a spec
oni init <spec.yaml> --force             delete and rebuild an existing namespace
oni update <slug> key=value [...]        update selected namespace settings
oni <slug> add poller <name> --query Q   add a newsletter poller to a namespace
oni add-poller <slug> <name> --query Q   same as above, easier for scripts
oni status                               show every configured namespace
oni status <slug>                        show one namespace
oni status --json                        machine-readable output (agents)
oni status -w                            refresh status every second
oni start <slug>                         enable a systemd timer
oni start --all                          enable all configured timers
oni query <slug> [--where field=value]   read parsed records as JSON
oni search <slug> <query>                semantic search over parsed records
oni logs <slug>                          show service logs
```

The poll, parse, and index stages are not separate CLI commands.

## Status

`oni status` is the primary health check for an operator or downstream agent.
The default output is human-readable; pass `--json` to get a structured payload.

```jsonc
{
  "namespace": "newsletter-demo",
  "health": "ok",            // "ok" | "warn" | "error"
  "notes": [],               // human hints, one per detected issue
  "interval_minutes": 60,
  "timer":   { "state": "active", "next_run_at": "...", "last_run_at": "..." },
  "service": { "state": "inactive", "last_result": "success", "last_exit_code": 0,
               "last_started_at": "...", "last_finished_at": "..." },
  "pipeline": { "emails": 5, "pending": 0, "failed": 0, "records": 12, "embedded": 12 },
  "pollers": [
    {
      "name": "coolstuffnyc",
      "configured": true,
      "enabled": true,
      "queries": ["from:coolstuffnyc@substack.com"],
      "emails": 3, "failed": 0,
      "last_fetched_at": "...", "last_subject": "...", "last_error": null
    }
  ]
}
```

Health is `error` when the timer is missing/inactive or the last run failed,
`warn` when a configured poller has zero emails after at least one run (likely
a wrong `gmail_query`) or any email failed to parse, otherwise `ok`. Each
non-`ok` reason is also surfaced in `notes`.

After upgrading the `oni` package, run `oni start <namespace>` once for each
namespace so the systemd unit's `ExecStart` is regenerated against the current
worker.

## DB schema

- `emails(id, source, message_id UNIQUE, from_addr, subject, received_at, raw_text, fetched_at, parsed_at, parse_error)`
- configured output table from `schema.yaml`, with `id`, `email_id`, `source`, custom columns, `raw_json`, and `extracted_at`

The default output table is still `events`:

```yaml
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
  - name: neighborhood
    type: text
    index: true
```

Re-parse a single email by clearing its `parsed_at`, then let the next cycle
pick it up:
```sh
sqlite3 $DB_PATH "UPDATE emails SET parsed_at=NULL, parse_error=NULL WHERE id=42; DELETE FROM events WHERE email_id=42;"
```

Use your configured table name instead of `events` for non-event pollers.

## Configuration

Each poller has a `poller.yaml`:

```yaml
analyzer:
  provider: anthropic
  api_key_env: ANTHROPIC_API_KEY
  model: claude-sonnet-4-6
  prompt: prompt.md
  schema: schema.yaml
```

Secrets are read from environment variables, optionally after loading
`openclaw_env`.

## License

MIT.
