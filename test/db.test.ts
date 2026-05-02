import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_OUTPUT_SCHEMA } from "../src/config.js";
import { connect, initDb, insertEmail, insertRecords, markEmailFailed, markEmailParsed, queryRecords, unparsedEmails } from "../src/db.js";

test("database lifecycle supports retries and event replacement", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "oni-db-")), "newsletters.db");
  initDb(dbPath, DEFAULT_OUTPUT_SCHEMA);
  const db = connect(dbPath);
  try {
    const emailId = insertEmail(db, {
      source: "test",
      messageId: "m1",
      fromAddr: "sender@example.com",
      subject: "Events",
      receivedAt: "2026-05-02T12:00:00.000Z",
      rawText: "A show this Saturday"
    });
    assert.equal(emailId, 1);
    assert.equal(insertEmail(db, {
      source: "test",
      messageId: "m1",
      rawText: "duplicate"
    }), null);

    assert.deepEqual(unparsedEmails(db).map((row) => row.id), [1]);
    markEmailFailed(db, 1, "bad parse");
    assert.deepEqual(unparsedEmails(db).map((row) => row.id), []);
    assert.deepEqual(unparsedEmails(db, { retryFailed: true }).map((row) => row.id), [1]);
    markEmailParsed(db, 1);
    assert.deepEqual(unparsedEmails(db, { retryFailed: true }).map((row) => row.id), []);

    insertRecords(db, DEFAULT_OUTPUT_SCHEMA, 1, "test", [{ name: "Old", date: "2026-05-01" }]);
    insertRecords(db, DEFAULT_OUTPUT_SCHEMA, 1, "test", [{ name: "New", date: "2026-05-02", tags: ["music"] }]);
    const rows = queryRecords(db, DEFAULT_OUTPUT_SCHEMA, { limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, "New");
  } finally {
    db.close();
  }
});

test("database supports custom parsed output tables", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "oni-db-")), "newsletters.db");
  const schema = {
    recordName: "deal",
    table: "deals",
    rootKey: "deals",
    columns: [
      { name: "title", type: "text" as const, required: true, index: false },
      { name: "company", type: "text" as const, required: false, index: true },
      { name: "discount_percent", type: "integer" as const, required: false, index: false },
      { name: "metadata", type: "json" as const, required: false, index: false }
    ]
  };
  initDb(dbPath, schema);
  const db = connect(dbPath);
  try {
    const emailId = insertEmail(db, {
      source: "deals",
      messageId: "m1",
      rawText: "ACME has 25 percent off"
    });
    assert.equal(emailId, 1);
    insertRecords(db, schema, 1, "deals", [{
      title: "ACME sale",
      company: "ACME",
      discount_percent: "25",
      metadata: { category: "retail" }
    }]);
    const rows = queryRecords(db, schema, { where: ["company=ACME"], orderBy: "-discount_percent", limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, "ACME sale");
    assert.equal(rows[0]?.discount_percent, 25);
  } finally {
    db.close();
  }
});

test("database upgrades legacy events tables for configurable records", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "oni-db-")), "newsletters.db");
  initDb(dbPath);
  const db = connect(dbPath);
  try {
    db.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      email_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      date TEXT,
      tags_json TEXT,
      extracted_at TEXT NOT NULL
    )`);
    const emailId = insertEmail(db, {
      source: "test",
      messageId: "m1",
      rawText: "A show this Saturday"
    });
    assert.equal(emailId, 1);
    insertRecords(db, DEFAULT_OUTPUT_SCHEMA, 1, "test", [{ name: "New", date: "2026-05-02", tags: ["music"] }]);
    const rows = queryRecords(db, DEFAULT_OUTPUT_SCHEMA, { limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.raw_json, JSON.stringify({ name: "New", date: "2026-05-02", tags: ["music"] }));
  } finally {
    db.close();
  }
});
