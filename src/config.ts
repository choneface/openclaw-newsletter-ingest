import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";

export type OutputColumn = {
  name: string;
  type: "text" | "integer" | "number" | "boolean" | "json";
  required: boolean;
  index: boolean;
};

export type OutputSchema = {
  recordName: string;
  table: string;
  rootKey: string;
  columns: OutputColumn[];
};

export type Source = {
  name: string;
  description: string;
  gmailQuery: string;
  parser: string;
  enabled: boolean;
};

export type Settings = {
  gmailUser: string;
  gmailAppPassword: string;
  gmailFolder: string;
  imapConnectionTimeoutMs: number;
  imapGreetingTimeoutMs: number;
  imapSocketTimeoutMs: number;
  anthropicApiKey: string;
  model: string;
  dbPath: string;
  logLevel: string;
};

export type PollerConfig = {
  slug: string;
  root: string;
  settings: Settings;
  sourcesPath: string;
  promptPath: string;
  schemaPath: string;
  output: OutputSchema;
  intervalMinutes: number;
  provider: string;
};

export const DEFAULT_PROMPT = `You extract NYC events from newsletter emails.

Read the email and return a JSON object whose top-level key is configured by
the output schema. For the default configuration, return an "events" array.
Each event should have a name and as many of the optional fields as the email
actually specifies. Leave a field null if it is not mentioned. Do not invent
details.

Dates: convert relative dates like "this Saturday" to ISO YYYY-MM-DD using
the email's received-at date as the reference point if provided.

Neighborhood: only fill in if the email names a NYC neighborhood explicitly
or via a venue you are highly confident about.

Tags: choose from a small open vocabulary like music, food, art, outdoor,
nightlife, family, theater, film, talk, market, festival, free, ticketed.

If the email contains no actual events, return {"events": []}.
`;

export const DEFAULT_OUTPUT_SCHEMA: OutputSchema = {
  recordName: "event",
  table: "events",
  rootKey: "events",
  columns: [
    { name: "name", type: "text", required: true, index: false },
    { name: "date", type: "text", required: false, index: true },
    { name: "end_date", type: "text", required: false, index: false },
    { name: "time", type: "text", required: false, index: false },
    { name: "location", type: "text", required: false, index: false },
    { name: "neighborhood", type: "text", required: false, index: true },
    { name: "price", type: "text", required: false, index: false },
    { name: "link", type: "text", required: false, index: false },
    { name: "blurb", type: "text", required: false, index: false },
    { name: "tags", type: "json", required: false, index: false }
  ]
};

export const DEFAULT_SCHEMA_YAML = `# Parsed output schema for this poller.
# Change this file to store any kind of structured records, not just events.
# Supported column types: text, integer, number, boolean, json.

record_name: event
table: events
root_key: events
columns:
  - name: name
    type: text
    required: true
  - name: date
    type: text
    index: true
  - name: end_date
    type: text
  - name: time
    type: text
  - name: location
    type: text
  - name: neighborhood
    type: text
    index: true
  - name: price
    type: text
  - name: link
    type: text
  - name: blurb
    type: text
  - name: tags
    type: json
`;

const DEFAULT_SOURCES = `# Newsletter sources for this poller.
# Gmail queries use Gmail search syntax, the same text you would type into
# Gmail's search bar.

- name: _self_test
  description: Test source - emails tagged [oni-test] in the subject
  gmail_query: 'subject:"[oni-test]"'
  parser: default_event_extractor
  enabled: true
`;

function defaultPollerYaml(slug: string, intervalMinutes: number, openclawEnv: string, analyzerProvider = "anthropic"): string {
  return `version: 1
slug: ${slug}
interval_minutes: ${intervalMinutes}

imap:
  host: imap.gmail.com
  folder: INBOX
  user_env: GMAIL_USER
  app_password_env: GMAIL_APP_PASSWORD
  connection_timeout_ms: 15000
  greeting_timeout_ms: 10000
  socket_timeout_ms: 30000

analyzer:
  provider: ${analyzerProvider}
  api_key_env: ANTHROPIC_API_KEY
  model: claude-sonnet-4-6
  prompt: prompt.md
  schema: schema.yaml

database:
  path: newsletters.db

sources: sources.yaml
log_level: INFO
openclaw_env: ${openclawEnv ? JSON.stringify(openclawEnv) : "\"\""}
`;
}

export function oniHome(path?: string): string {
  if (path) return resolve(path.replace(/^~(?=$|\/)/, homedir()));
  return resolve((process.env.ONI_HOME ?? "~/.oni").replace(/^~(?=$|\/)/, homedir()));
}

export function ensureOniHome(home: string): void {
  mkdirSync(join(home, "pollers"), { recursive: true });
  const configPath = join(home, "config.yaml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "version: 1\npollers_dir: pollers\n");
  }
}

export function initPoller(options: {
  slug: string;
  home: string;
  intervalMinutes: number;
  openclawEnv?: string;
  analyzerProvider?: string;
  schema?: OutputSchema;
  force?: boolean;
}): string {
  ensureOniHome(options.home);
  const root = join(options.home, "pollers", options.slug);
  if (existsSync(root) && !options.force) {
    throw new Error(`poller already exists: ${options.slug}`);
  }
  mkdirSync(join(root, "logs"), { recursive: true });
  writeTemplate(
    join(root, "poller.yaml"),
    defaultPollerYaml(options.slug, options.intervalMinutes, options.openclawEnv ?? "", options.analyzerProvider ?? "anthropic"),
    Boolean(options.force)
  );
  writeTemplate(join(root, "sources.yaml"), DEFAULT_SOURCES, Boolean(options.force));
  writeTemplate(join(root, "prompt.md"), DEFAULT_PROMPT, Boolean(options.force));
  writeTemplate(join(root, "schema.yaml"), formatOutputSchema(options.schema ?? DEFAULT_OUTPUT_SCHEMA), Boolean(options.force));
  return root;
}

function writeTemplate(path: string, text: string, force: boolean): void {
  if (force || !existsSync(path)) writeFileSync(path, text);
}

export function loadPoller(slug: string, options: { home: string; requireSecrets?: boolean }): PollerConfig {
  const root = join(options.home, "pollers", slug);
  const configPath = join(root, "poller.yaml");
  if (!existsSync(configPath)) throw new Error(`poller not found: ${slug} (${configPath})`);

  const raw = YAML.parse(readFileSync(configPath, "utf8")) ?? {};
  if (raw.openclaw_env && existsSync(raw.openclaw_env)) {
    dotenv.config({ path: raw.openclaw_env, override: false });
  }

  const imap = raw.imap ?? {};
  const analyzer = raw.analyzer ?? {};
  const database = raw.database ?? {};
  const requireSecrets = options.requireSecrets ?? true;

  const envValue = (name: string): string => {
    const value = process.env[name];
    if (!value && requireSecrets) throw new Error(`${name} is not set`);
    return value ?? "";
  };

  const dbPath = resolvePollerPath(root, database.path ?? "newsletters.db");
  const schemaPath = resolvePollerPath(root, analyzer.schema ?? raw.schema ?? "schema.yaml");
  const output = existsSync(schemaPath) ? loadOutputSchema(schemaPath) : DEFAULT_OUTPUT_SCHEMA;
  return {
    slug,
    root,
    settings: {
      gmailUser: envValue(imap.user_env ?? "GMAIL_USER"),
      gmailAppPassword: envValue(imap.app_password_env ?? "GMAIL_APP_PASSWORD").replaceAll(" ", ""),
      gmailFolder: imap.folder ?? "INBOX",
      imapConnectionTimeoutMs: Number(imap.connection_timeout_ms ?? 15000),
      imapGreetingTimeoutMs: Number(imap.greeting_timeout_ms ?? 10000),
      imapSocketTimeoutMs: Number(imap.socket_timeout_ms ?? 30000),
      anthropicApiKey: envValue(analyzer.api_key_env ?? "ANTHROPIC_API_KEY"),
      model: analyzer.model ?? "claude-sonnet-4-6",
      dbPath,
      logLevel: raw.log_level ?? "INFO"
    },
    sourcesPath: resolvePollerPath(root, raw.sources ?? "sources.yaml"),
    promptPath: resolvePollerPath(root, analyzer.prompt ?? "prompt.md"),
    schemaPath,
    output,
    intervalMinutes: Number(raw.interval_minutes ?? 30),
    provider: analyzer.provider ?? "anthropic"
  };
}

export function loadSources(path: string): Source[] {
  const raw = YAML.parse(readFileSync(path, "utf8")) ?? [];
  if (!Array.isArray(raw)) throw new Error(`${path} must contain a YAML list`);
  return raw
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      name: String(entry.name),
      description: String(entry.description ?? ""),
      gmailQuery: String(entry.gmail_query ?? entry.gmailQuery),
      parser: String(entry.parser ?? "default_event_extractor"),
      enabled: entry.enabled !== false
    }));
}

export function readPrompt(path: string): string {
  return readFileSync(path, "utf8");
}

export function loadOutputSchema(path: string): OutputSchema {
  const raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
  const columnsRaw = raw.columns;
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) {
    throw new Error(`${path} must define at least one output column`);
  }
  const schema: OutputSchema = {
    recordName: String(raw.record_name ?? raw.recordName ?? "record"),
    table: String(raw.table ?? "records"),
    rootKey: String(raw.root_key ?? raw.rootKey ?? "records"),
    columns: columnsRaw.map((column) => ({
      name: String(column.name),
      type: normalizeColumnType(column.type),
      required: Boolean(column.required),
      index: Boolean(column.index)
    }))
  };
  validateOutputSchema(schema, path);
  return schema;
}

export function formatOutputSchema(schema: OutputSchema): string {
  return YAML.stringify({
    record_name: schema.recordName,
    table: schema.table,
    root_key: schema.rootKey,
    columns: schema.columns.map((column) => ({
      name: column.name,
      type: column.type,
      ...(column.required ? { required: true } : {}),
      ...(column.index ? { index: true } : {})
    }))
  });
}

function resolvePollerPath(root: string, value: string): string {
  const expanded = value.replace(/^~(?=$|\/)/, homedir());
  return isAbsolute(expanded) ? expanded : join(root, expanded);
}

function normalizeColumnType(value: unknown): OutputColumn["type"] {
  const type = String(value ?? "text");
  if (["text", "integer", "number", "boolean", "json"].includes(type)) return type as OutputColumn["type"];
  throw new Error(`unsupported output column type: ${type}`);
}

function validateOutputSchema(schema: OutputSchema, path = "schema"): void {
  validateIdentifier(schema.table, `${path} table`);
  validateJsonKey(schema.rootKey, `${path} root_key`);
  if (!schema.recordName.trim()) throw new Error(`${path} record_name is required`);
  const seen = new Set(["id", "email_id", "source", "extracted_at", "raw_json"]);
  for (const column of schema.columns) {
    validateIdentifier(column.name, `${path} column`);
    if (seen.has(column.name)) throw new Error(`${path} column uses reserved or duplicate name: ${column.name}`);
    seen.add(column.name);
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a SQLite-safe identifier: ${value}`);
  }
}

function validateJsonKey(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} must be a JSON key-like value: ${value}`);
  }
}
