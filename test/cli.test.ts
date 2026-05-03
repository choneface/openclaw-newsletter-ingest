import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("oni init, status, and query work through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", "demo"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const status = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "status"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.match(status, /demo/);
  assert.match(status, /emails=0/);

  const query = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "query", "demo"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(query.trim(), "[]");
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
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", "ai-news"], {
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

test("oni init help includes prompt configuration", () => {
  const help = execFileSync("node", ["--import", "tsx", "src/cli.ts", "init", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.match(help, /--parsing-prompt <prompt>/);
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
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", "deals"], {
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

test("oni init can configure semantic model settings", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  execFileSync("node", [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "init",
    "semantic-demo",
    "--semantic-model",
    "custom/embedder",
    "--semantic-dimensions",
    "12"
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
  execFileSync("node", [
    "--import",
    "tsx",
    "src/cli.ts",
    "--home",
    home,
    "init",
    "prompt-demo",
    "--parsing-prompt",
    "Extract civic meetings as JSON."
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const prompt = readFileSync(join(home, "pollers", "prompt-demo", "prompt.md"), "utf8");

  assert.equal(prompt, "Extract civic meetings as JSON.");
});
