# AGENTS.md

This file is the entry point for any coding agent (Claude Code, Codex CLI,
Cursor, etc.) working in this repository. It mirrors `CLAUDE.md` so that any
agent picking up this repo finds the same conventions.

## What this repo is

`@choneface/oni` is a small TypeScript/ESM Node CLI that polls Gmail
newsletters on a systemd timer, has Claude extract structured records, and
stores them in SQLite + a local sqlite-vec semantic index. Downstream
OpenClaw agents read the resulting database via `oni query`, `oni search`,
or direct SQLite access.

## Architecture

```
systemd timer → systemd oneshot service → node dist/worker.js <namespace>
                                              │
                                              ▼
                                runPollerCycle (src/cycle.ts)
                                  ├─ poll  (src/poller.ts)
                                  ├─ parse (src/analyzer.ts)
                                  └─ index (src/semantic.ts)
                                              │
                                              ▼
                          ~/.oni/pollers/<namespace>/newsletters.db
                                              │
                                              ▼
                           OpenClaw agents (oni query / search / SQL)
```

A **namespace** owns one DB, prompt, schema, and timer. A **poller** is a
single Gmail source inside that namespace's `sources.yaml`. Multiple pollers
in one namespace share extraction logic.

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

## CLI surface

The public CLI is intentionally small:

`init`, `update`, `add-poller`, `start`, `status`, `query`, `search`, `logs`.

Do **not** add pipeline-stage verbs (`poll`, `parse`, `run`, `index`,
`stop`) — they are implementation details and would break the contract
agents depend on. See `SKILL.md` for the canonical surface.

## `oni status` is load-bearing

It is the primary tool downstream agents use to confirm ingestion is
healthy. Changes there are release-blocking unless paired with:

- a `SKILL.md` update of the JSON payload example,
- a test in `test/cli.test.ts` asserting the new shape,
- a `README.md` update if the human-readable output changes.

## Release checklist

Follow semantic versioning for every release so agents do not need to ask the
operator which version number to use:

- **Major** (`x.0.0`): breaking changes to the public CLI, namespace/poller
  config shape, database contract, `oni status` JSON, or agent-facing behavior.
- **Minor** (`0.x.0`): backward-compatible public features, new flags, new
  supported config/spec fields, or additive status/query/search capabilities.
- **Patch** (`0.0.x`): bug fixes, docs, tests, dependency maintenance, and
  internal refactors that do not change the public contract.

Before bumping `version` in `package.json` and pushing a `v*` tag:

1. `npm test` passes.
2. `SKILL.md` matches the shipped code — commands list, vocabulary, status
   payload, and flags. Downstream agents read `SKILL.md`, not the source.
3. `README.md` matches the shipped code — the CLI cheat-sheet and any
   sections you touched.
4. `CLAUDE.md` / `AGENTS.md` still describe the architecture and module
   map accurately.

CI lints and tests on push; the publish workflow runs on a `v*` tag push.

## House rules

- Default to **no comments**. Names carry their own meaning.
- Don't add features, abstractions, or backwards-compat shims beyond what
  the task requires.
- Validate at boundaries (Gmail input, LLM output, user-provided YAML).
- After an npm upgrade on the VPS, the operator must re-run
  `oni start <namespace>` so the systemd unit's `ExecStart` is regenerated
  against the current worker. Note any change that breaks the worker argv
  in the release notes.
- Secrets live in the `openclaw_env` dotenv file referenced by
  `poller.yaml`. Never commit `.env`, never log secret values.
