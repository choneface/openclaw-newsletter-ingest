import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect, initDb, insertEmail, insertEvents, markEmailFailed, markEmailParsed, queryEvents, unparsedEmails } from "../src/db.js";

test("database lifecycle supports retries and event replacement", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "oni-db-")), "newsletters.db");
  initDb(dbPath);
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

    insertEvents(db, 1, "test", [{ name: "Old", date: "2026-05-01" }]);
    insertEvents(db, 1, "test", [{ name: "New", date: "2026-05-02", tags: ["music"] }]);
    const rows = queryEvents(db, { limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, "New");
  } finally {
    db.close();
  }
});
