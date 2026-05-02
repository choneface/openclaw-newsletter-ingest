import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { OutputColumn, OutputSchema } from "./config.js";

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

export type RecordInput = Record<string, unknown>;

export function connect(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function initDb(dbPath: string, output?: OutputSchema): void {
  const db = connect(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    if (output) ensureRecordTable(db, output);
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

export function ensureRecordTable(db: Database.Database, output: OutputSchema): void {
  validateOutputSchema(output);
  const columns = output.columns
    .map((column) => `${quoteIdentifier(column.name)} ${sqliteType(column)}${column.required ? " NOT NULL" : ""}`)
    .join(",\n    ");
  db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(output.table)} (
    id              INTEGER PRIMARY KEY,
    email_id        INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    source          TEXT    NOT NULL,
    ${columns},
    raw_json        TEXT    NOT NULL,
    extracted_at    TEXT    NOT NULL
);`);
  const existingColumns = tableColumns(db, output.table);
  for (const [name, type] of Object.entries(RECORD_BASE_COLUMNS)) {
    if (!existingColumns.has(name)) {
      db.exec(`ALTER TABLE ${quoteIdentifier(output.table)} ADD COLUMN ${quoteIdentifier(name)} ${type};`);
      existingColumns.add(name);
    }
  }
  for (const column of output.columns) {
    if (!existingColumns.has(column.name)) {
      db.exec(`ALTER TABLE ${quoteIdentifier(output.table)} ADD COLUMN ${quoteIdentifier(column.name)} ${sqliteType(column)};`);
      existingColumns.add(column.name);
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${output.table}_email`)} ON ${quoteIdentifier(output.table)}(email_id);`);
  for (const column of output.columns.filter((entry) => entry.index)) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${output.table}_${column.name}`)} ON ${quoteIdentifier(output.table)}(${quoteIdentifier(column.name)});`);
  }
}

export function insertRecords(db: Database.Database, output: OutputSchema, emailId: number, source: string, records: RecordInput[]): number {
  ensureRecordTable(db, output);
  db.prepare(`DELETE FROM ${quoteIdentifier(output.table)} WHERE email_id = ?`).run(emailId);
  if (records.length === 0) return 0;
  const insertColumns = ["email_id", "source", ...output.columns.map((column) => column.name), "raw_json", "extracted_at"];
  const placeholders = insertColumns.map(() => "?").join(", ");
  const insert = db.prepare(`INSERT INTO ${quoteIdentifier(output.table)}
    (${insertColumns.map(quoteIdentifier).join(", ")})
    VALUES (${placeholders})`);
  const ts = nowIso();
  for (const record of records) {
    insert.run(...[
      emailId,
      source,
      ...output.columns.map((column) => coerceColumnValue(column, record[column.name])),
      JSON.stringify(record),
      ts
    ]);
  }
  return records.length;
}

export function queryRecords(db: Database.Database, output: OutputSchema, filters: {
  dateFrom?: string;
  dateTo?: string;
  source?: string;
  neighborhood?: string;
  where?: string[];
  orderBy?: string;
  limit: number;
}): Record<string, unknown>[] {
  ensureRecordTable(db, output);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.dateFrom && hasColumn(output, "date")) {
    where.push("date >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo && hasColumn(output, "date")) {
    where.push("date <= ?");
    params.push(filters.dateTo);
  }
  if (filters.source) {
    where.push("source = ?");
    params.push(filters.source);
  }
  if (filters.neighborhood && hasColumn(output, "neighborhood")) {
    where.push("neighborhood = ?");
    params.push(filters.neighborhood);
  }
  for (const clause of filters.where ?? []) {
    const [field, ...rest] = clause.split("=");
    if (!field || rest.length === 0) throw new Error(`expected --where field=value, got ${clause}`);
    const value = rest.join("=");
    if (field !== "source" && !hasColumn(output, field)) throw new Error(`cannot filter unknown output field: ${field}`);
    where.push(`${quoteIdentifier(field)} = ?`);
    params.push(value);
  }
  const orderBy = filters.orderBy
    ? orderBySql(output, filters.orderBy)
    : hasColumn(output, "date")
      ? "date IS NULL, date, id"
      : "id";
  const sql = `SELECT * FROM ${quoteIdentifier(output.table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy} LIMIT ?`;
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

`;

const RECORD_BASE_COLUMNS: Record<string, string> = {
  email_id: "INTEGER",
  source: "TEXT",
  raw_json: "TEXT",
  extracted_at: "TEXT"
};

function sqliteType(column: OutputColumn): string {
  if (column.type === "integer" || column.type === "boolean") return "INTEGER";
  if (column.type === "number") return "REAL";
  return "TEXT";
}

function coerceColumnValue(column: OutputColumn, value: unknown): unknown {
  if (value == null) {
    if (column.required && column.type === "text") return "";
    return null;
  }
  if (column.type === "json") return JSON.stringify(value);
  if (column.type === "boolean") return Boolean(value) ? 1 : 0;
  if (column.type === "integer") return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null;
  if (column.type === "number") return Number.isFinite(Number(value)) ? Number(value) : null;
  return String(value);
}

function hasColumn(output: OutputSchema, name: string): boolean {
  return output.columns.some((column) => column.name === name);
}

function orderBySql(output: OutputSchema, value: string): string {
  const descending = value.startsWith("-");
  const field = descending ? value.slice(1) : value;
  if (field !== "id" && field !== "source" && !hasColumn(output, field)) {
    throw new Error(`cannot order by unknown output field: ${field}`);
  }
  return `${quoteIdentifier(field)}${descending ? " DESC" : ""}, id`;
}

function validateOutputSchema(output: OutputSchema): void {
  validateIdentifier(output.table);
  for (const column of output.columns) validateIdentifier(column.name);
}

function validateIdentifier(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQLite identifier: ${value}`);
  }
}

function quoteIdentifier(value: string): string {
  validateIdentifier(value);
  return `"${value}"`;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
