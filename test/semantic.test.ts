import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_OUTPUT_SCHEMA, type SemanticConfig } from "../src/config.js";
import { connect, initDb, insertEmail, insertRecords } from "../src/db.js";
import { type Embedder, indexRecords, searchRecords } from "../src/semantic.js";

const semantic: SemanticConfig = {
  provider: "transformers",
  model: "test-embedder",
  dimensions: 3
};

const embedder: Embedder = {
  async embed(texts: string[]) {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      if (lower.includes("music")) return [1, 0, 0];
      if (lower.includes("art")) return [0, 1, 0];
      return [0, 0, 1];
    });
  }
};

test("semantic index searches parsed records through sqlite-vec", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "oni-semantic-")), "newsletters.db");
  initDb(dbPath, DEFAULT_OUTPUT_SCHEMA);
  const db = connect(dbPath);
  try {
    const emailId = insertEmail(db, {
      source: "test",
      messageId: "m1",
      subject: "Weekend ideas",
      rawText: "Music and gallery picks"
    });
    assert.equal(emailId, 1);
    insertRecords(db, DEFAULT_OUTPUT_SCHEMA, emailId, "test", [
      { name: "Basement jazz", blurb: "Live music downtown", tags: ["music"] },
      { name: "Gallery walk", blurb: "New art openings", tags: ["art"] }
    ]);

    assert.deepEqual(await indexRecords(db, DEFAULT_OUTPUT_SCHEMA, semantic, { embedder }), {
      indexed: 2,
      skipped: 0
    });
    assert.deepEqual(await indexRecords(db, DEFAULT_OUTPUT_SCHEMA, semantic, { embedder }), {
      indexed: 0,
      skipped: 2
    });

    const rows = await searchRecords(db, DEFAULT_OUTPUT_SCHEMA, semantic, "music tonight", {
      limit: 2,
      embedder
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.record.name, "Basement jazz");
    assert.equal(rows[0]?.distance, 0);
    assert.equal(rows[0]?.source, "test");
  } finally {
    db.close();
  }
});

test("semantic index does not load an embedder when there are no records", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "oni-semantic-empty-")), "newsletters.db");
  initDb(dbPath, DEFAULT_OUTPUT_SCHEMA);
  const db = connect(dbPath);
  try {
    assert.deepEqual(await indexRecords(db, DEFAULT_OUTPUT_SCHEMA, semantic), {
      indexed: 0,
      skipped: 0
    });
  } finally {
    db.close();
  }
});
