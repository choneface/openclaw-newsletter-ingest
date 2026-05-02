import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initPoller, loadPoller, loadSources } from "../src/config.js";

test("initPoller creates editable poller files", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-config-"));
  const root = initPoller({ slug: "coolstuffnyc", home, intervalMinutes: 15 });

  const cfg = loadPoller("coolstuffnyc", { home, requireSecrets: false });
  assert.equal(root, join(home, "pollers", "coolstuffnyc"));
  assert.equal(cfg.slug, "coolstuffnyc");
  assert.equal(cfg.intervalMinutes, 15);
  assert.equal(cfg.settings.dbPath, join(root, "newsletters.db"));
  assert.equal(loadSources(cfg.sourcesPath)[0]?.name, "_self_test");
});
