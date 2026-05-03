import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { OutputColumn, OutputSchema, SemanticConfig } from "./config.js";

export type Embedder = {
  embed(texts: string[]): Promise<number[][]>;
};

export type IndexResult = {
  indexed: number;
  skipped: number;
};

export type SearchResult = {
  distance: number;
  target_type: string;
  target_table: string;
  target_id: number;
  email_id: number | null;
  source: string;
  content: string;
  record: Record<string, unknown>;
};

type SemanticItemRow = {
  id: number;
  content_hash: string;
};

type RecordRow = Record<string, unknown> & {
  id: number;
  email_id: number;
  source: string;
  email_subject?: string | null;
  email_received_at?: string | null;
};

type SearchItemRow = {
  distance: number;
  target_type: string;
  target_table: string;
  target_id: number;
  email_id: number | null;
  source: string;
  content: string;
};

export async function indexRecords(db: Database.Database, output: OutputSchema, semantic: SemanticConfig, options: {
  limit?: number;
  rebuild?: boolean;
  embedder?: Embedder;
} = {}): Promise<IndexResult> {
  ensureSemanticSchema(db, semantic);
  const vectorTable = semanticVectorTable(semantic);
  if (options.rebuild) {
    db.prepare(`DELETE FROM ${quoteIdentifier(vectorTable)} WHERE rowid IN (SELECT id FROM semantic_items WHERE target_type = ? AND target_table = ? AND model = ?)`).run("record", output.table, semantic.model);
    db.prepare("DELETE FROM semantic_items WHERE target_type = ? AND target_table = ? AND model = ?").run("record", output.table, semantic.model);
  }
  removeDeletedRecordItems(db, output, semantic);
  const rows = recordRows(db, output, options.limit);
  if (rows.length === 0) return { indexed: 0, skipped: 0 };
  const embedder = options.embedder ?? await createEmbedder(semantic);
  let indexed = 0;
  let skipped = 0;
  for (const row of rows) {
    const content = recordContent(output, row);
    const contentHash = hashContent(content);
    const existing = db.prepare(`SELECT id, content_hash FROM semantic_items
      WHERE target_type = ? AND target_table = ? AND target_id = ? AND model = ?`)
      .get("record", output.table, row.id, semantic.model) as SemanticItemRow | undefined;
    if (existing?.content_hash === contentHash) {
      skipped += 1;
      continue;
    }
    const [embedding] = await embedder.embed([content]);
    if (!embedding) throw new Error("embedder returned no embedding");
    validateEmbedding(embedding, semantic);
    const itemId = upsertSemanticItem(db, {
      existingId: existing?.id,
      targetType: "record",
      targetTable: output.table,
      targetId: row.id,
      emailId: row.email_id,
      source: row.source,
      content,
      contentHash,
      model: semantic.model,
      dimensions: semantic.dimensions
    });
    db.prepare(`DELETE FROM ${quoteIdentifier(vectorTable)} WHERE rowid = ?`).run(BigInt(itemId));
    db.prepare(`INSERT INTO ${quoteIdentifier(vectorTable)}(rowid, embedding) VALUES (?, ?)`).run(BigInt(itemId), JSON.stringify(embedding));
    indexed += 1;
  }
  return { indexed, skipped };
}

export async function searchRecords(db: Database.Database, output: OutputSchema, semantic: SemanticConfig, query: string, options: {
  limit: number;
  embedder?: Embedder;
}): Promise<SearchResult[]> {
  ensureSemanticSchema(db, semantic);
  const vectorTable = semanticVectorTable(semantic);
  const embedder = options.embedder ?? await createEmbedder(semantic);
  const [embedding] = await embedder.embed([query]);
  if (!embedding) throw new Error("embedder returned no query embedding");
  validateEmbedding(embedding, semantic);
  const rows = db.prepare(`SELECT
      v.distance,
      i.target_type,
      i.target_table,
      i.target_id,
      i.email_id,
      i.source,
      i.content
    FROM ${quoteIdentifier(vectorTable)} v
    JOIN semantic_items i ON i.id = v.rowid
    WHERE v.embedding MATCH ?
      AND v.k = ?
      AND i.target_type = ?
      AND i.target_table = ?
      AND i.model = ?
    ORDER BY v.distance
    LIMIT ?`).all(JSON.stringify(embedding), Number(options.limit), "record", output.table, semantic.model, Number(options.limit)) as SearchItemRow[];

  return rows.map((row) => ({
    ...row,
    record: recordById(db, output, row.target_id)
  }));
}

export async function createEmbedder(semantic: SemanticConfig): Promise<Embedder> {
  if (semantic.provider !== "transformers") throw new Error(`unsupported semantic provider: ${semantic.provider}`);
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", semantic.model);
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const list = output.tolist() as number[][] | number[][][];
      if (texts.length === 1 && typeof list[0]?.[0] === "number") return list as number[][];
      return list as number[][];
    }
  };
}

export function ensureSemanticSchema(db: Database.Database, semantic: SemanticConfig): void {
  validateDimensions(semantic.dimensions);
  sqliteVec.load(db);
  db.exec(`CREATE TABLE IF NOT EXISTS semantic_items (
    id              INTEGER PRIMARY KEY,
    target_type     TEXT    NOT NULL,
    target_table    TEXT    NOT NULL,
    target_id       INTEGER NOT NULL,
    email_id        INTEGER,
    source          TEXT    NOT NULL,
    content         TEXT    NOT NULL,
    content_hash    TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    dimensions      INTEGER NOT NULL,
    embedded_at     TEXT    NOT NULL,
    UNIQUE(target_type, target_table, target_id, model)
);`);
  db.exec("CREATE INDEX IF NOT EXISTS semantic_items_target ON semantic_items(target_type, target_table, target_id);");
  db.exec("CREATE INDEX IF NOT EXISTS semantic_items_model ON semantic_items(model);");
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(semanticVectorTable(semantic))} USING vec0(
    embedding float[${semantic.dimensions}]
);`);
}

function upsertSemanticItem(db: Database.Database, input: {
  existingId?: number;
  targetType: string;
  targetTable: string;
  targetId: number;
  emailId: number | null;
  source: string;
  content: string;
  contentHash: string;
  model: string;
  dimensions: number;
}): number {
  const ts = new Date().toISOString();
  if (input.existingId) {
    db.prepare(`UPDATE semantic_items SET
      email_id = ?,
      source = ?,
      content = ?,
      content_hash = ?,
      dimensions = ?,
      embedded_at = ?
      WHERE id = ?`).run(input.emailId, input.source, input.content, input.contentHash, input.dimensions, ts, input.existingId);
    return input.existingId;
  }
  const result = db.prepare(`INSERT INTO semantic_items
    (target_type, target_table, target_id, email_id, source, content, content_hash, model, dimensions, embedded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.targetType,
      input.targetTable,
      input.targetId,
      input.emailId,
      input.source,
      input.content,
      input.contentHash,
      input.model,
      input.dimensions,
      ts
    );
  return Number(result.lastInsertRowid);
}

function recordRows(db: Database.Database, output: OutputSchema, limit?: number): RecordRow[] {
  const sql = `SELECT r.*, e.subject AS email_subject, e.received_at AS email_received_at
    FROM ${quoteIdentifier(output.table)} r
    LEFT JOIN emails e ON e.id = r.email_id
    ORDER BY r.id${limit ? " LIMIT ?" : ""}`;
  return (limit ? db.prepare(sql).all(Number(limit)) : db.prepare(sql).all()) as RecordRow[];
}

function recordById(db: Database.Database, output: OutputSchema, id: number): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${quoteIdentifier(output.table)} WHERE id = ?`).get(id) as Record<string, unknown>;
}

function recordContent(output: OutputSchema, row: RecordRow): string {
  const parts = [
    labeled("source", row.source),
    labeled("email_subject", row.email_subject),
    labeled("email_received_at", row.email_received_at),
    ...output.columns.map((column) => labeled(column.name, columnValue(column, row[column.name])))
  ].filter(Boolean);
  return parts.join("\n");
}

function columnValue(column: OutputColumn, value: unknown): unknown {
  if (value == null) return null;
  if (column.type !== "json" || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function labeled(label: string, value: unknown): string | null {
  if (value == null || value === "") return null;
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return `${label}: ${rendered}`;
}

function removeDeletedRecordItems(db: Database.Database, output: OutputSchema, semantic: SemanticConfig): void {
  const vectorTable = semanticVectorTable(semantic);
  const stale = db.prepare(`SELECT i.id
    FROM semantic_items i
    LEFT JOIN ${quoteIdentifier(output.table)} r ON r.id = i.target_id
    WHERE i.target_type = ?
      AND i.target_table = ?
      AND i.model = ?
      AND r.id IS NULL`).all("record", output.table, semantic.model) as Array<{ id: number }>;
  for (const row of stale) {
    db.prepare(`DELETE FROM ${quoteIdentifier(vectorTable)} WHERE rowid = ?`).run(BigInt(row.id));
    db.prepare("DELETE FROM semantic_items WHERE id = ?").run(row.id);
  }
}

function semanticVectorTable(semantic: SemanticConfig): string {
  return `semantic_vec_${semantic.dimensions}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateEmbedding(embedding: number[], semantic: SemanticConfig): void {
  if (embedding.length !== semantic.dimensions) {
    throw new Error(`embedding model ${semantic.model} returned ${embedding.length} dimensions; expected ${semantic.dimensions}`);
  }
  if (!embedding.every((value) => Number.isFinite(value))) throw new Error("embedding contains a non-finite value");
}

function validateDimensions(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 4096) {
    throw new Error(`semantic dimensions must be an integer from 1 to 4096, got ${value}`);
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}
