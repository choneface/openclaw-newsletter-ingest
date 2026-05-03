import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addSource, initPoller, loadOutputSchema, loadPoller, loadSources } from "../src/config.js";

test("initPoller creates editable poller files", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-config-"));
  const root = initPoller({ slug: "coolstuffnyc", home, intervalMinutes: 15 });

  const cfg = loadPoller("coolstuffnyc", { home, requireSecrets: false });
  assert.equal(root, join(home, "pollers", "coolstuffnyc"));
  assert.equal(cfg.slug, "coolstuffnyc");
  assert.equal(cfg.intervalMinutes, 15);
  assert.equal(cfg.provider, "anthropic");
  assert.equal(cfg.semantic.provider, "transformers");
  assert.equal(cfg.semantic.model, "Xenova/all-MiniLM-L6-v2");
  assert.equal(cfg.semantic.dimensions, 384);
  assert.equal(cfg.settings.dbPath, join(root, "newsletters.db"));
  assert.equal(cfg.output.table, "events");
  assert.equal(cfg.output.rootKey, "events");
  assert.equal(loadOutputSchema(cfg.schemaPath).columns[0]?.name, "name");
  assert.equal(loadSources(cfg.sourcesPath)[0]?.name, "_self_test");
  assert.deepEqual(loadSources(cfg.sourcesPath)[0]?.gmailQueries, ['subject:"[oni-test]"']);
});

test("initPoller can create mock analyzer pollers for smoke tests", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-config-"));
  initPoller({ slug: "smoke", home, intervalMinutes: 15, analyzerProvider: "mock" });

  const cfg = loadPoller("smoke", { home, requireSecrets: false });
  assert.equal(cfg.provider, "mock");
});

test("initPoller can template a custom parsed output schema", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-config-"));
  initPoller({
    slug: "deals",
    home,
    intervalMinutes: 15,
    schema: {
      recordName: "deal",
      table: "deals",
      rootKey: "deals",
      columns: [
        { name: "title", type: "text", required: true, index: false },
        { name: "company", type: "text", required: false, index: true }
      ]
    }
  });

  const cfg = loadPoller("deals", { home, requireSecrets: false });
  assert.equal(cfg.output.recordName, "deal");
  assert.equal(cfg.output.table, "deals");
  assert.equal(cfg.output.columns[1]?.index, true);
});

test("loadSources accepts one or many Gmail queries per source", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-config-"));
  const path = join(home, "sources.yaml");
  writeFileSync(path, `- name: single
  gmail_query: from:single@example.com
- name: multi
  gmail_queries:
    - from:multi@example.com
    - subject:"Multi Newsletter"
    - subject:"Multi Newsletter"
`);

  const sources = loadSources(path);

  assert.deepEqual(sources[0]?.gmailQueries, ["from:single@example.com"]);
  assert.deepEqual(sources[1]?.gmailQueries, ["from:multi@example.com", 'subject:"Multi Newsletter"']);
});

test("addSource appends a namespace poller with multiple queries", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-config-"));
  initPoller({ slug: "ai-news", home, intervalMinutes: 15 });
  const cfg = loadPoller("ai-news", { home, requireSecrets: false });

  addSource(cfg.sourcesPath, {
    name: "ben-evans",
    description: "Benedict Evans newsletter",
    gmailQueries: ["from:newsletter@ben-evans.com", 'subject:"Benedict Evans"']
  });

  const added = loadSources(cfg.sourcesPath).find((source) => source.name === "ben-evans");
  assert.deepEqual(added?.gmailQueries, ["from:newsletter@ben-evans.com", 'subject:"Benedict Evans"']);
});
