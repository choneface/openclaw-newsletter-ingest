import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function writeSpec(home: string, namespace: string, overrides = ""): string {
  const path = join(home, `${namespace}.spec.yaml`);
  writeFileSync(path, `namespace: ${namespace}
interval_minutes: 30
openclaw_env: /tmp/openclaw.env
prompt: Extract useful records as JSON.
schema:
  record_name: event
  table: events
  root_key: events
  columns:
    - name: name
      type: text
      required: true
    - name: neighborhood
      type: text
      index: true
semantic:
  provider: transformers
  model: Xenova/all-MiniLM-L6-v2
  dimensions: 384
pollers:
  - name: _self_test
    gmail_query: 'subject:"[oni-test]"'
${overrides}`);
  return path;
}

test("oni init, status, and query work through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "demo");
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const status = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "status"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.match(status, /demo/);
  assert.match(status, /emails=0/);
  assert.match(status, /pollers:/);

  const query = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "query", "demo"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(query.trim(), "[]");
});

test("oni status --json emits a structured payload for agents", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "demo");
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  execFileSync("node", [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "demo",
    "add",
    "poller",
    "moma",
    "--query",
    "from:newsletters@email.moma.org"
  ], { cwd: process.cwd(), encoding: "utf8" });

  const raw = execFileSync("node", [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "status",
    "demo",
    "--json"
  ], { cwd: process.cwd(), encoding: "utf8" });
  const status = JSON.parse(raw);

  assert.equal(status.namespace, "demo");
  assert.ok(["ok", "warn", "error"].includes(status.health));
  assert.equal(typeof status.interval_minutes, "number");
  assert.ok(status.timer);
  assert.ok(status.service);
  assert.ok(status.pipeline);
  assert.equal(status.pipeline.emails, 0);
  assert.ok(Array.isArray(status.pollers));
  const moma = status.pollers.find((entry: { name: string }) => entry.name === "moma");
  assert.ok(moma, "expected moma poller in status output");
  assert.equal(moma.configured, true);
  assert.deepEqual(moma.queries, ["from:newsletters@email.moma.org"]);
  assert.equal(moma.emails, 0);
});

test("oni status --json without slug returns an array", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "demo");
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const raw = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "status", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].namespace, "demo");
});

test("oni help shows the compact public CLI", () => {
  const help = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.match(help, /init/);
  assert.match(help, /update/);
  assert.match(help, /add-poller/);
  assert.match(help, /status/);
  assert.match(help, /start/);
  assert.match(help, /query/);
  assert.match(help, /search/);
  assert.match(help, /logs/);
  assert.doesNotMatch(help, /schema-add-column/);
  assert.doesNotMatch(help, /^\s+poll\b/m);
  assert.doesNotMatch(help, /^\s+parse\b/m);
  assert.doesNotMatch(help, /^\s+index\b/m);
});

test("oni namespace add poller appends a Gmail poller to sources", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "ai-news");
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  execFileSync("node", [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "ai-news",
    "add",
    "poller",
    "ben-evans",
    "--description",
    "Benedict Evans newsletter",
    "--query",
    "from:newsletter@ben-evans.com",
    "--query",
    "subject:\"Benedict Evans\""
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const sources = readFileSync(join(home, "pollers", "ai-news", "sources.yaml"), "utf8");

  assert.match(sources, /name: ben-evans/);
  assert.match(sources, /gmail_queries:/);
  assert.match(sources, /from:newsletter@ben-evans\.com/);
  assert.match(sources, /subject:"Benedict Evans"/);
});

test("oni reports its package version", () => {
  const version = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--version"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
});

test("oni init help describes spec-based initialization", () => {
  const help = execFileSync("node", ["--import", "tsx", "src/cli.ts", "init", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.match(help, /<spec>/);
  assert.match(help, /--force/);
});

test("low-level commands do not exist", () => {
  for (const command of ["sources", "schema", "schema-set", "schema-add-column", "poll", "parse", "run", "index", "stop"]) {
    const result = spawnSync("node", ["--import", "tsx", "src/cli.ts", command], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /unknown command/i, command);
  }
  const hiddenRun = spawnSync("node", ["--import", "tsx", "src/cli.ts", "start", "demo", "--run-once"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.notEqual(hiddenRun.status, 0);
  assert.match(hiddenRun.stderr, /unknown option/i);
});

test("oni update configures parsed output through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "deals");
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "update", "deals", "record-name=deal", "table=deals", "root-key=deals"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const schema = readFileSync(join(home, "pollers", "deals", "schema.yaml"), "utf8");

  assert.match(schema, /table: deals/);
  assert.match(schema, /root_key: deals/);
});

test("oni init refuses existing namespaces unless --force rebuilds them", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "rebuild-demo");
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const dbPath = join(home, "pollers", "rebuild-demo", "newsletters.db");
  assert.ok(existsSync(dbPath));

  const duplicate = spawnSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /poller already exists: rebuild-demo/);

  const forced = spawnSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", spec, "--force"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(forced.status, 0);
  assert.match(forced.stderr, /WARNING: deleting existing namespace rebuild-demo/);
  assert.ok(existsSync(dbPath));
});

test("oni init can configure semantic model settings", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "semantic-demo");
  writeFileSync(spec, `namespace: semantic-demo
semantic:
  provider: transformers
  model: custom/embedder
  dimensions: 12
pollers:
  - name: ai
    gmail_query: from:ai@example.com
`);
  execFileSync("node", [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "init",
    spec
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const pollerYaml = readFileSync(join(home, "pollers", "semantic-demo", "poller.yaml"), "utf8");

  assert.match(pollerYaml, /semantic:/);
  assert.match(pollerYaml, /model: "custom\/embedder"/);
  assert.match(pollerYaml, /dimensions: 12/);
});

test("oni init can configure the parsing prompt", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  const spec = writeSpec(home, "prompt-demo");
  writeFileSync(spec, `namespace: prompt-demo
prompt: Extract civic meetings as JSON.
pollers:
  - name: civic
    gmail_query: from:civic@example.com
`);
  execFileSync("node", [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "init",
    spec
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const prompt = readFileSync(join(home, "pollers", "prompt-demo", "prompt.md"), "utf8");

  assert.equal(prompt, "Extract civic meetings as JSON.");
});
