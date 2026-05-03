# Working in this repo

`@choneface/oni` is a small Node CLI (TypeScript, ESM) that polls Gmail
newsletters on a systemd timer, asks an LLM to extract structured records,
stores them in SQLite alongside a local sqlite-vec semantic index, and lets
agents read them via `oni query` / `oni search` or directly from the DB.

It runs on a Debian VPS as a global npm install. Most users are downstream
OpenClaw agents that depend on the contracts in `SKILL.md` — keep them stable.

## Architecture

```
   systemd timer (oni-<namespace>.timer)
        ↓
   systemd service (oneshot) → node dist/worker.js <namespace>
        ↓
   runPollerCycle: poll → parse → index
        │
        ├─ poll  (src/poller.ts)   IMAP fetch → emails table
        ├─ parse (src/cycle.ts +
        │        src/analyzer.ts)  Claude extraction → output table
        └─ index (src/semantic.ts) Transformers.js embeddings → sqlite-vec
        ↓
   ~/.oni/pollers/<namespace>/newsletters.db
        ↓
   OpenClaw agents read it (oni query / oni search / direct SQLite)
```

A **namespace** (`~/.oni/pollers/<namespace>/`) owns one DB, prompt, schema,
and timer. A **poller** is a single Gmail source inside that namespace's
`sources.yaml`. Several pollers in one namespace share extraction logic — see
the multi-poller section in `README.md`.

## Module map

```
src/cli.ts        commander entrypoint; only the public verbs
src/config.ts     load/save namespace + sources, env resolution
src/cycle.ts      runPollerCycle — orchestrates poll/parse/index
src/poller.ts     IMAP fetch + dedupe via emails.message_id
src/analyzer.ts   Anthropic call + JSON validation against schema.yaml
src/db.ts         SQLite open, emails table, dynamic output table DDL
src/semantic.ts   Transformers.js embeddings + sqlite-vec
src/status.ts     collectStatus / formatStatusText (the agent's #1 tool)
src/systemd.ts    unit file generation + systemctl/journalctl wrappers
src/worker.ts     systemd entrypoint — runPollerCycle from argv
test/*.test.ts    node --test, run with `npm test`
```

## CLI conventions

The CLI surface is intentionally small (see `SKILL.md`). Resist adding
pipeline-stage verbs (`poll`, `parse`, `run`, `index`, `stop`) — they are
implementation details and break the SKILL contract that downstream agents
depend on. The public surface is: `init`, `update`, `add-poller`, `start`,
`status`, `query`, `search`, `logs`. `oni <ns> add poller ...` is rewritten
to `add-poller` in `cli.ts` so both forms work.

## Status is load-bearing

`oni status` is the agent's primary health check. Treat regressions there as
release-blocking: any change to its output should keep the JSON shape stable
where possible, update `SKILL.md`'s payload example, and add a test asserting
the shape (`test/cli.test.ts`).

## Release checklist

This is pre-release software with one downstream consumer (the operator on
the VPS) — backward compatibility is *not* a hard constraint, but **docs and
tests are**.

Before bumping `version` in `package.json` and pushing a tag:

1. **`npm test`** passes locally.
2. **`SKILL.md` is up to date** — the commands list, vocabulary, status
   payload shape, and any new flags must match the code on this commit.
   Downstream agents read `SKILL.md`, not the source. If a new public verb
   or status field landed and `SKILL.md` doesn't mention it, the release is
   not ready.
3. **`README.md` is up to date** — the CLI cheat-sheet at the bottom and
   any sections you touched must reflect what shipped.
4. **`CLAUDE.md` / `AGENTS.md`** still describe the architecture and module
   map accurately. Update them if you moved code, added a module, or changed
   the namespace/poller model.

CI runs `npm run lint` and `npm test` on push (`.github/workflows`). The
publish workflow runs on a `v*` tag push.

## House rules

- Default to **no comments**. Names should carry their own meaning.
- Don't add features, abstractions, or backwards-compat shims beyond what
  the task requires. This is pre-release; rename and delete freely.
- Validate at boundaries (Gmail input, LLM output, user-provided YAML).
  Trust internal calls.
- The systemd unit is regenerated on every `oni start`. After an npm
  upgrade, the operator must re-run `oni start <namespace>` — document this
  if you change `dist/worker.js` argv.
- Secrets live in `openclaw_env` (a dotenv path in `poller.yaml`). Never
  commit `.env`, never log secret values.
