import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initPoller, loadOutputSchema, loadPoller, loadSources } from "../src/config.js";

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
