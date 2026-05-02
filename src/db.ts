import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type EmailRow = {
  id: number;
  source: string;
  message_id: string;
  from_addr: string | null;
  subject: string | null;
  received_at: string | null;
  raw_text: string | null;
  fetched_at: string;
  parsed_at: string | null;
  parse_error: string | null;
};

export type EventInput = {
  name?: string;
  date?: string | null;
  end_date?: string | null;
  time?: string | null;
  location?: string | null;
  neighborhood?: string | null;
  price?: string | null;
  link?: string | null;
  blurb?: string | null;
  tags?: string[];
};

export function connect(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function initDb(dbPath: string): void {
  const db = connect(dbPath);
  try {
    db.exec(SCHEMA_SQL);
  } finally {
    db.close();
  }
}

export function insertEmail(db: Database.Database, input: {
  source: string;
  messageId: string;
  fromAddr?: string | null;
  subject?: string | null;
  receivedAt?: string | null;
  rawText: string;
}): number | null {
  try {
    const result = db.prepare(`INSERT INTO emails
      (source, message_id, from_addr, subject, received_at, raw_text, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        input.source,
        input.messageId,
        input.fromAddr ?? null,
        input.subject ?? null,
        input.receivedAt ?? null,
        input.rawText,
        nowIso()
      );
    return Number(result.lastInsertRowid);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return null;
    throw error;
  }
}

export function unparsedEmails(db: Database.Database, options: { limit?: number; retryFailed?: boolean } = {}): EmailRow[] {
  const where = options.retryFailed ? "(parsed_at IS NULL OR parse_error IS NOT NULL)" : "parsed_at IS NULL";
  const limit = options.limit ? ` LIMIT ${Number(options.limit)}` : "";
  return db.prepare(`SELECT * FROM emails WHERE ${where} ORDER BY id${limit}`).all() as EmailRow[];
}

export function markEmailParsed(db: Database.Database, emailId: number): void {
  db.prepare("UPDATE emails SET parsed_at = ?, parse_error = NULL WHERE id = ?").run(nowIso(), emailId);
}

export function markEmailFailed(db: Database.Database, emailId: number, error: string): void {
  db.prepare("UPDATE emails SET parsed_at = ?, parse_error = ? WHERE id = ?").run(nowIso(), error, emailId);
}

export function insertEvents(db: Database.Database, emailId: number, source: string, events: EventInput[]): number {
  db.prepare("DELETE FROM events WHERE email_id = ?").run(emailId);
  if (events.length === 0) return 0;
  const insert = db.prepare(`INSERT INTO events
    (email_id, source, name, date, end_date, time, location, neighborhood, price, link, blurb, tags_json, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ts = nowIso();
  for (const event of events) {
    insert.run(
      emailId,
      source,
      event.name || "(unnamed)",
      event.date ?? null,
      event.end_date ?? null,
      event.time ?? null,
      event.location ?? null,
      event.neighborhood ?? null,
      event.price ?? null,
      event.link ?? null,
      event.blurb ?? null,
      JSON.stringify(event.tags ?? []),
      ts
    );
  }
  return events.length;
}

export function queryEvents(db: Database.Database, filters: {
  dateFrom?: string;
  dateTo?: string;
  source?: string;
  neighborhood?: string;
  limit: number;
}): Record<string, unknown>[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.dateFrom) {
    where.push("date >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("date <= ?");
    params.push(filters.dateTo);
  }
  if (filters.source) {
    where.push("source = ?");
    params.push(filters.source);
  }
  if (filters.neighborhood) {
    where.push("neighborhood = ?");
    params.push(filters.neighborhood);
  }
  const sql = `SELECT * FROM events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY date IS NULL, date, id LIMIT ?`;
  return db.prepare(sql).all(...params, Number(filters.limit)) as Record<string, unknown>[];
}

function nowIso(): string {
  return new Date().toISOString();
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS emails (
    id              INTEGER PRIMARY KEY,
    source          TEXT    NOT NULL,
    message_id      TEXT    NOT NULL UNIQUE,
    from_addr       TEXT,
    subject         TEXT,
    received_at     TEXT,
    raw_text        TEXT,
    fetched_at      TEXT    NOT NULL,
    parsed_at       TEXT,
    parse_error     TEXT
);
CREATE INDEX IF NOT EXISTS emails_unparsed ON emails(parsed_at) WHERE parsed_at IS NULL;
CREATE INDEX IF NOT EXISTS emails_source ON emails(source);

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY,
    email_id        INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    source          TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    date            TEXT,
    end_date        TEXT,
    time            TEXT,
    location        TEXT,
    neighborhood    TEXT,
    price           TEXT,
    link            TEXT,
    blurb           TEXT,
    tags_json       TEXT,
    extracted_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events(date);
CREATE INDEX IF NOT EXISTS events_neighborhood ON events(neighborhood);
CREATE INDEX IF NOT EXISTS events_email ON events(email_id);
`;
