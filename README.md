# oni

OpenClaw Newsletter Ingest: poll Gmail newsletters, analyze them with an LLM,
and store structured event data in SQLite for OpenClaw agents to query.

## Architecture

```
   systemd timer
        │
        ▼
   oni run <slug> --once
   ├── poll  → IMAP fetch per sources.yaml entry → emails table
   └── parse → prompt.md + analyzer config → events table
        │
        ▼
   SQLite in ~/.oni/pollers/<slug>/newsletters.db
        │
        ▼
   OpenClaw agent query helper
```

Code runs on the VPS host as a Node CLI installed with npm.

## Install

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
oni init weekendercrix --interval-minutes 30 --openclaw-env /docker/openclaw-874u/.env
```

This creates:

```text
~/.oni/
  config.yaml
  pollers/
    weekendercrix/
      poller.yaml
      sources.yaml
      prompt.md
      newsletters.db
      logs/
```

Edit `poller.yaml` for model/API/provider settings, `sources.yaml` for Gmail
queries, and `prompt.md` for the analyzer instructions.

## Onboarding a new source

Edit `sources.yaml`:

```yaml
- name: timeout-nyc
  description: TimeOut NYC weekly picks
  gmail_query: 'from:newsletter@timeout.com'   # Gmail search syntax
  parser: default_event_extractor
  enabled: true
```

Run `oni run weekendercrix --once` to test it.

`gmail_query` accepts anything Gmail's search bar accepts — `from:`, `to:`, `subject:`, `label:`, `after:`, `older_than:`, parentheses, `OR`, `-`. See [Gmail's search reference](https://support.google.com/mail/answer/7190).

## Custom parsing logic

The default analyzer uses `prompt.md` plus the source metadata in
`sources.yaml` to extract events from most NYC newsletters. If a source needs
different extraction behavior, create a separate poller with a tailored
`prompt.md` or extend `src/analyzer.ts` and the `parser` dispatch in
`sources.yaml`.

You'll need:
- A Gmail account with **2FA enabled** (required for app passwords)
- An app password from https://myaccount.google.com/apppasswords
- An Anthropic API key

## Run On The VPS

```sh
npm install -g @choneface/oni
oni init weekendercrix --openclaw-env /docker/openclaw-874u/.env
oni run weekendercrix --once
oni start weekendercrix
```

`oni start <slug>` writes a systemd service/timer pair named
`oni-<slug>.service` and `oni-<slug>.timer`.

## CLI

```
oni init <slug>                          create a poller folder
oni sources <slug>                       list configured sources
oni poll <slug> [--source S] [--limit N] fetch new emails
oni parse <slug> [--limit N]             analyze unparsed emails
oni run <slug> --once                    poll + parse once
oni query <slug> [--from D] [--to D]     read events as JSON
oni start <slug>                         enable systemd timer
oni stop <slug>                          disable systemd timer
oni status <slug>                        show timer status
oni logs <slug>                          show service logs
```

## DB schema

- `emails(id, source, message_id UNIQUE, from_addr, subject, received_at, raw_text, fetched_at, parsed_at, parse_error)`
- `events(id, email_id, source, name, date, end_date, time, location, neighborhood, price, link, blurb, tags_json, extracted_at)`

Re-parse a single email by clearing its `parsed_at`:
```sh
sqlite3 $DB_PATH "UPDATE emails SET parsed_at=NULL, parse_error=NULL WHERE id=42; DELETE FROM events WHERE email_id=42;"
oni parse weekendercrix
```

## Configuration

Each poller has a `poller.yaml`:

```yaml
analyzer:
  provider: anthropic
  api_key_env: ANTHROPIC_API_KEY
  model: claude-sonnet-4-6
  prompt: prompt.md
```

Secrets are read from environment variables, optionally after loading
`openclaw_env`.

## License

MIT.
