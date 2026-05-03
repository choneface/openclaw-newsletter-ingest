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

## Create A Poller

```sh
oni init newsletter-demo --interval-minutes 30 --openclaw-env /path/to/openclaw.env --parsing-prompt "Extract NYC events as JSON."
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

By default, ONI creates an event schema compatible with city activity
newsletters. To start with different naming:

```sh
oni init deals --record-name deal --table deals --root-key deals
```

To use a different local embedding model, set the model and dimensions at
initialization:

```sh
oni init deals --semantic-model Xenova/all-MiniLM-L6-v2 --semantic-dimensions 384
```

Non-default naming starts with generic `title`, `summary`, `link`, and `tags`
columns. Then edit `schema.yaml` to define the actual columns:

```yaml
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
```

Supported column types are `text`, `integer`, `number`, `boolean`, and `json`.
ONI always adds `id`, `email_id`, `source`, `raw_json`, and `extracted_at`.

For simple naming/model/prompt changes, update only the fields that are changing:

```sh
oni update deals record-name=deal table=deals root-key=deals
oni update deals semantic-model=Xenova/all-MiniLM-L6-v2 semantic-dimensions=384
oni update deals parsing-prompt="Extract retail deals as JSON."
```

For column changes, edit `schema.yaml`; ONI will initialize the configured table
the next time the poller runs.

## Onboarding a new source

Edit `sources.yaml`:

```yaml
- name: timeout-nyc
  description: TimeOut NYC weekly picks
  gmail_query: 'from:newsletter@timeout.com'   # Gmail search syntax
  parser: default_event_extractor
  enabled: true
```

Run `oni start newsletter-demo` to let systemd run it on the configured interval.

`gmail_query` accepts anything Gmail's search bar accepts — `from:`, `to:`, `subject:`, `label:`, `after:`, `older_than:`, parentheses, `OR`, `-`. See [Gmail's search reference](https://support.google.com/mail/answer/7190).

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
separate poller with a tailored `prompt.md`/`schema.yaml` or extend
`src/analyzer.ts` and the `parser` dispatch in `sources.yaml`.

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
oni init newsletter-demo --openclaw-env /path/to/openclaw.env
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
oni init <slug>                          create a poller folder
oni update <slug> key=value [...]        update selected poller settings
oni status                               show every configured poller
oni status -w                            refresh status every second
oni start <slug>                         enable a systemd timer
oni start --all                          enable all configured timers
oni query <slug> [--where field=value]   read parsed records as JSON
oni search <slug> <query>                semantic search over parsed records
oni logs <slug>                          show service logs
```

The poll, parse, and index stages are not separate CLI commands.

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
