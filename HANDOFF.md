# ONI TypeScript Pivot Handoff

Current stopping point: the project has been pivoted away from Python toward an npm-installed TypeScript CLI named `oni` (`OpenClaw Newsletter Ingest`). The local npm workflow now installs, builds, tests, and passes a built CLI smoke test.

## Product Direction

- User-facing CLI: `oni`
- Distribution target: npm package `@choneface/oni`
- Runtime: Node/TypeScript, not Python
- Poller state layout:

```text
~/.oni/
  config.yaml
  pollers/
    <slug>/
      poller.yaml
      sources.yaml
      prompt.md
      newsletters.db
      logs/
```

`poller.yaml` owns machine config like provider/model/API env vars, IMAP env vars, DB path, interval, source file, and prompt path. `prompt.md` owns the analyzer instructions sent to the LLM.

## What Changed Locally

- Removed Python package files from the active project:
  - `pyproject.toml`
  - `src/openclaw_newsletter_ingest/*`
  - Python tests under `tests/`
- Added TypeScript/npm files:
  - `package.json`
  - `tsconfig.json`
  - `src/cli.ts`
  - `src/config.ts`
  - `src/db.ts`
  - `src/analyzer.ts`
  - `src/poller.ts`
  - `src/systemd.ts`
  - `test/*.test.ts`
- Updated `README.md`, `.env.example`, `.gitignore`, `scripts/install.sh`, and `sources.yaml` for the `oni` direction.

## Current TS Architecture

- `src/cli.ts`: Commander-based CLI with commands:
  - `oni init <slug>`
  - `oni sources <slug>`
  - `oni poll <slug>`
  - `oni parse <slug>`
  - `oni run <slug> --once`
  - `oni query <slug>`
  - `oni start|stop|status|logs <slug>`
- `src/config.ts`: creates/loads `~/.oni/pollers/<slug>` config, sources, and prompt.
- `src/db.ts`: SQLite schema/helpers using `better-sqlite3`.
- `src/poller.ts`: Gmail IMAP polling via `imapflow` + `mailparser`.
- `src/analyzer.ts`: Anthropic extraction, currently expects JSON text from Claude and parses it.
- `src/systemd.ts`: writes `oni-<slug>.service` and `oni-<slug>.timer`.

## Verification Status

Verified before TS pivot:

- Python version had VPS tests passing (`9 passed`) before we pivoted away.

Verified locally after TS pivot:

- `npm install --no-audit --no-fund`
- `npm run build`
- `npm test`
- Built CLI smoke test:
  - `npm exec -- node dist/cli.js --home /tmp/oni-smoke init smoke --force`
  - `npm exec -- node dist/cli.js --home /tmp/oni-smoke query smoke`
  - expected output: `[]`

Not yet verified after TS pivot:

- live IMAP/API run
- npm package install from the registry after publishing

Note: local `npm install` initially failed in the sandbox due DNS restrictions, then failed with nonexistent `@anthropic-ai/sdk@^0.42.0`. The dependency is now `^0.92.0` and `package-lock.json` has been generated.

## VPS State

Using `ovps`, I installed the VPS prerequisites:

```sh
apt-get install -y nodejs npm build-essential python3 make g++
```

That completed successfully. VPS now has Ubuntu’s Node 18/npm 9. This is why `src/db.ts` was switched from Node 22’s experimental `node:sqlite` to `better-sqlite3`, so ONI can run on stock Ubuntu Node.

Partial sync exists at `/opt/oni`, but it may be stale because `package.json` changed after the first sync. Re-sync before testing.

## Likely Fixes Needed

- Run a real `oni poll`/`oni parse` against Gmail and Anthropic credentials.
- Anthropic extraction should eventually use tool/schema output instead of “please return JSON text”.
- Consider renaming repo/package description fully from `openclaw-newsletter-ingest` to `oni`.
- Runtime schema is embedded in `src/db.ts`; the legacy top-level `schema.sql` has been removed.

## Desired End State

```sh
npm install -g @choneface/oni
oni init weekendercrix --openclaw-env /docker/openclaw-874u/.env
oni run weekendercrix --once
oni start weekendercrix
oni logs weekendercrix
```
