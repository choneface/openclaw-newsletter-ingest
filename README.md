# openclaw-newsletter-ingest

Polls Gmail for newsletters, extracts events with Claude Sonnet, stores them in SQLite for an [openclaw](https://github.com/hostinger/hvps-openclaw) agent to query.

Built for one specific use case (NYC events for a weekendercrix agent), but the source registry and parser interface make it easy to fork for other domains.

## Architecture

```
   cron (every 30 min)
        │
        ▼
   nli run                          # poll + parse, on the VPS host
   ├── poll  → IMAP fetch per source.yaml entry → emails table
   └── parse → Claude Sonnet → events table
        │
        ▼
   SQLite at $DB_PATH (inside the openclaw data volume)
        │
        ▼
   weekendercrix `news-lookup` skill                # in-container query helper
```

Code runs on the VPS host (Python venv); the SQLite DB lives in the openclaw data volume so the in-container agent can read it directly.

## Onboarding a new source

Edit `sources.yaml`:

```yaml
- name: timeout-nyc
  description: TimeOut NYC weekly picks
  gmail_query: 'from:newsletter@timeout.com'   # Gmail search syntax
  parser: default_event_extractor
  enabled: true
```

Commit, pull on the VPS, run `nli run`. That's it.

`gmail_query` accepts anything Gmail's search bar accepts — `from:`, `to:`, `subject:`, `label:`, `after:`, `older_than:`, parentheses, `OR`, `-`. See [Gmail's search reference](https://support.google.com/mail/answer/7190).

## Custom parsing logic

The default parser (`extract_events` in `parser.py`) handles most NYC newsletters with one prompt. If you need source-specific extraction — different schema, custom post-processing, a tighter prompt — drop a module under `src/openclaw_newsletter_ingest/parsers/` and reference its name in `sources.yaml`. The dispatch lookup is intentionally simple; extend it when you need it.

## Local install

```sh
git clone https://github.com/choneface/openclaw-newsletter-ingest
cd openclaw-newsletter-ingest
python3 -m venv .venv && .venv/bin/pip install -e .
cp .env.example .env && $EDITOR .env       # GMAIL_USER, GMAIL_APP_PASSWORD, etc.
.venv/bin/nli init-db
.venv/bin/nli run
```

You'll need:
- A Gmail account with **2FA enabled** (required for app passwords)
- An app password from https://myaccount.google.com/apppasswords
- An Anthropic API key

## VPS install (using [ovps](https://github.com/choneface/ovps))

```sh
ovps exec 'cd /opt && git clone https://github.com/choneface/openclaw-newsletter-ingest && cd openclaw-newsletter-ingest && bash scripts/install.sh'
ovps exec 'nano /opt/openclaw-newsletter-ingest/.env'    # set GMAIL_*; ANTHROPIC_API_KEY auto-resolves from openclaw
ovps exec 'cd /opt/openclaw-newsletter-ingest && .venv/bin/nli run'
```

Cron (30 min cadence):
```cron
*/30 * * * * cd /opt/openclaw-newsletter-ingest && .venv/bin/nli run >> /var/log/nli.log 2>&1
```

## CLI

```
nli init-db                              create the schema
nli sources                              list configured sources
nli poll [--source S] [--limit N]        fetch new emails
nli parse [--limit N]                    run Claude on unparsed emails
nli run                                  poll + parse (cron entry point)
nli query [--from D] [--to D]            read events as JSON
       [--source S] [--neighborhood N]
       [--limit N]
```

## DB schema

- `emails(id, source, message_id UNIQUE, from_addr, subject, received_at, raw_text, fetched_at, parsed_at, parse_error)`
- `events(id, email_id, source, name, date, end_date, time, location, neighborhood, price, link, blurb, tags_json, extracted_at)`

Re-parse a single email by clearing its `parsed_at`:
```sh
sqlite3 $DB_PATH "UPDATE emails SET parsed_at=NULL, parse_error=NULL WHERE id=42; DELETE FROM events WHERE email_id=42;"
nli parse
```

## Configuration

See `.env.example`. Notable:

| Var | Notes |
|---|---|
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | App password, not your account password |
| `ANTHROPIC_API_KEY` | Leave blank on the VPS — `OPENCLAW_ENV` resolves it |
| `OPENCLAW_ENV` | Path to openclaw's docker-compose `.env`; we read the API key from there |
| `CLAUDE_MODEL` | Defaults to `claude-sonnet-4-6` |
| `DB_PATH` | Where the SQLite db lives. On the VPS this should be inside the openclaw data volume so the agent can read it. |

## License

MIT.
