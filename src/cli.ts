#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import YAML from "yaml";
import { connect, initDb, queryRecords } from "./db.js";
import {
  DEFAULT_OUTPUT_SCHEMA,
  DEFAULT_SEMANTIC_CONFIG,
  type OutputColumn,
  type OutputSchema,
  type PollerConfig,
  type PollerTemplate,
  type Source,
  addSource,
  formatOutputSchema,
  initPoller,
  listPollerSlugs,
  loadPoller,
  oniHome
} from "./config.js";
import { searchRecords } from "./semantic.js";
import { collectStatus, formatStatusText } from "./status.js";
import { journalctl, serviceName, systemctl, timerName, writeSystemdUnits } from "./systemd.js";

const program = new Command();

program
  .name("oni")
  .description("OpenClaw Newsletter Ingest")
  .version(readPackageVersion())
  .option("--home <path>", "ONI home directory")
  .option("--log-level <level>", "log level");

program.command("init")
  .argument("<spec>", "namespace spec YAML")
  .description("create a poller namespace from a spec")
  .option("--force", "delete an existing namespace before rebuilding it from the spec")
  .action((slug, options) => {
    const home = homeFromProgram();
    const spec = loadNamespaceSpec(slug);
    if (options.force) {
      console.error(`WARNING: deleting existing namespace ${spec.slug} before rebuilding from ${slug}`);
      console.error("WARNING: this removes the namespace database, logs, prompt, schema, and sources.");
    }
    const root = initPoller({ ...spec, home, force: Boolean(options.force) });
    initDb(resolve(root, "newsletters.db"), spec.schema ?? DEFAULT_OUTPUT_SCHEMA);
    console.log(`created ${root}`);
    console.log(`edit ${resolve(root, "poller.yaml")}`);
    console.log(`edit ${resolve(root, "sources.yaml")}`);
    console.log(`edit ${resolve(root, "prompt.md")}`);
    console.log(`edit ${resolve(root, "schema.yaml")}`);
  });

program.command("update")
  .argument("<slug>", "poller slug")
  .argument("[changes...]", "key=value changes")
  .allowUnknownOption(true)
  .description("update a poller by applying key=value changes")
  .action((slug, changes) => updatePoller(slug, changes));

program.command("add-poller")
  .argument("<slug>", "namespace slug")
  .argument("<name>", "poller name inside the namespace")
  .requiredOption("--query <gmail-query>", "Gmail search query; repeat for multiple queries", collectOption, [])
  .option("--description <text>", "human-readable source description", "")
  .option("--parser <parser>", "parser dispatch key", "default_event_extractor")
  .description("add a Gmail newsletter poller to a namespace")
  .action((slug, name, options) => addNamespacePoller(slug, name, options));

program.command("start")
  .argument("[slug]", "poller slug")
  .option("--all", "start every configured poller that is not already running")
  .description("start one or all poller timers")
  .action((slug, options) => {
    const home = homeFromProgram();
    const slugs = options.all ? listPollerSlugs(home) : [requiredSlug(slug, "start")];
    for (const selected of slugs) startPoller(selected, home);
  });

program.command("status")
  .argument("[slug]", "poller slug")
  .option("-w, --watch", "refresh every second")
  .option("--json", "emit machine-readable JSON")
  .description("show poller timer and pipeline status")
  .action((slug, options) => {
    const home = homeFromProgram();
    const render = () => {
      if (options.watch) process.stdout.write("\x1Bc");
      const slugs = slug ? [slug] : listPollerSlugs(home);
      const statuses = slugs.map((selected) => collectStatus(selected, home));
      if (options.json) {
        const payload = slug ? statuses[0] ?? null : statuses;
        console.log(JSON.stringify(payload, null, 2));
      } else {
        for (const status of statuses) console.log(formatStatusText(status));
      }
    };
    render();
    if (options.watch) setInterval(render, 1000);
  });

program.command("query")
  .argument("<slug>", "poller slug")
  .option("--from <date>", "start date")
  .option("--to <date>", "end date")
  .option("--source <name>", "source name")
  .option("--neighborhood <name>", "neighborhood")
  .option("--where <field=value...>", "filter parsed output fields by exact value")
  .option("--order-by <field>", "order by output field; prefix with - for descending")
  .option("--limit <n>", "max rows", parseNumber, 100)
  .description("query parsed records as JSON")
  .action((slug, options) => {
    const cfg = loadPoller(slug, { home: homeFromProgram(), requireSecrets: false });
    const db = connect(cfg.settings.dbPath);
    try {
      console.log(JSON.stringify(queryRecords(db, cfg.output, {
        dateFrom: options.from,
        dateTo: options.to,
        source: options.source,
        neighborhood: options.neighborhood,
        where: options.where,
        orderBy: options.orderBy,
        limit: options.limit
      }), null, 2));
    } finally {
      db.close();
    }
  });

program.command("search")
  .argument("<slug>", "poller slug")
  .argument("<query>", "semantic search query")
  .option("--limit <n>", "max rows", parseNumber, 10)
  .description("semantic search over parsed records")
  .action(async (slug, query, options) => {
    const cfg = loadPoller(slug, { home: homeFromProgram(), requireSecrets: false });
    const db = connect(cfg.settings.dbPath);
    try {
      const rows = await searchRecords(db, cfg.output, cfg.semantic, query, { limit: options.limit });
      console.log(JSON.stringify(rows, null, 2));
    } finally {
      db.close();
    }
  });

program.command("logs")
  .argument("<slug>", "poller slug")
  .option("-f, --follow", "follow logs")
  .option("-n, --lines <n>", "lines to show", parseNumber, 100)
  .description("show service logs")
  .action((slug, options) => {
    const args = ["-u", serviceName(slug), "--no-pager", "-n", String(options.lines)];
    if (options.follow) args.push("-f");
    journalctl(args);
  });

program.parseAsync(rewriteNamespacePollerArgs(process.argv)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function addNamespacePoller(slug: string, name: string, options: { query: string[]; description?: string; parser?: string }): void {
  const cfg = loadPoller(slug, { home: homeFromProgram(), requireSecrets: false });
  const source = addSource(cfg.sourcesPath, {
    name,
    description: options.description,
    gmailQueries: options.query,
    parser: options.parser
  });
  console.log(`added poller ${source.name} to ${slug}`);
  console.log(`queries=${source.gmailQueries.length}`);
  console.log(`edit ${cfg.sourcesPath}`);
}

function loadNamespaceSpec(path: string): PollerTemplate {
  const raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must contain a YAML object`);
  const spec = raw as Record<string, unknown>;
  const slug = stringValue(spec.namespace ?? spec.slug, `${path} namespace`);
  const intervalMinutes = numberValue(spec.interval_minutes ?? spec.intervalMinutes ?? spec.schedule_minutes ?? spec.scheduleMinutes ?? 30, `${path} interval_minutes`);
  const analyzer = objectValue(spec.analyzer, `${path} analyzer`);
  const semantic = objectValue(spec.semantic, `${path} semantic`);
  const sources = sourceList(spec.pollers ?? spec.sources ?? [], path);
  return {
    slug,
    intervalMinutes,
    openclawEnv: optionalString(spec.openclaw_env ?? spec.openclawEnv),
    analyzerProvider: optionalString(analyzer.provider),
    analyzerModel: optionalString(analyzer.model),
    prompt: optionalString(spec.prompt),
    semantic: {
      provider: parseSemanticProvider(String(semantic.provider ?? DEFAULT_SEMANTIC_CONFIG.provider)),
      model: String(semantic.model ?? DEFAULT_SEMANTIC_CONFIG.model),
      dimensions: parseSemanticDimensions(String(semantic.dimensions ?? DEFAULT_SEMANTIC_CONFIG.dimensions))
    },
    schema: schemaValue(spec.schema, path),
    sources
  };
}

function sourceList(value: unknown, path: string): Source[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} must define at least one poller`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${path} pollers[${index}] must be an object`);
    const raw = entry as Record<string, unknown>;
    const name = stringValue(raw.name, `${path} pollers[${index}].name`);
    const queries = queryList(raw.gmail_queries ?? raw.gmailQueries ?? raw.gmail_query ?? raw.gmailQuery, `${path} pollers[${index}]`);
    return {
      name,
      description: optionalString(raw.description) ?? "",
      gmailQueries: queries,
      parser: optionalString(raw.parser) ?? "default_event_extractor",
      enabled: raw.enabled !== false
    };
  });
}

function queryList(value: unknown, label: string): string[] {
  const queries = Array.isArray(value)
    ? value.map((query) => String(query).trim()).filter(Boolean)
    : [String(value ?? "").trim()].filter(Boolean);
  if (queries.length === 0) throw new Error(`${label} must define gmail_query or gmail_queries`);
  return Array.from(new Set(queries));
}

function schemaValue(value: unknown, path: string): OutputSchema {
  if (value === undefined || value === null) return DEFAULT_OUTPUT_SCHEMA;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} schema must be an object`);
  const raw = value as Record<string, unknown>;
  const columns = raw.columns;
  if (!Array.isArray(columns) || columns.length === 0) throw new Error(`${path} schema.columns must contain at least one column`);
  return {
    recordName: String(raw.record_name ?? raw.recordName ?? "record"),
    table: String(raw.table ?? "records"),
    rootKey: String(raw.root_key ?? raw.rootKey ?? "records"),
    columns: columns.map((column, index) => columnValue(column, `${path} schema.columns[${index}]`))
  };
}

function columnValue(value: unknown, label: string): OutputColumn {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const type = String(raw.type ?? "text");
  if (!["text", "integer", "number", "boolean", "json"].includes(type)) throw new Error(`${label}.type is unsupported: ${type}`);
  return {
    name: stringValue(raw.name, `${label}.name`),
    type: type as OutputColumn["type"],
    required: Boolean(raw.required),
    index: Boolean(raw.index)
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function numberValue(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number, got ${value}`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function updatePoller(slug: string, changes: string[]): void {
  if (changes.length === 0) throw new Error("expected at least one key=value change");
  const home = homeFromProgram();
  const cfg = loadPoller(slug, { home, requireSecrets: false });
  const pollerPath = join(cfg.root, "poller.yaml");
  const raw = YAML.parse(readFileSync(pollerPath, "utf8")) ?? {};
  let schema: OutputSchema | null = null;
  let wrotePrompt = false;

  for (const change of changes) {
    const [key, ...rest] = change.split("=");
    if (!key || rest.length === 0) throw new Error(`expected key=value, got ${change}`);
    const value = rest.join("=");
    switch (normalizeUpdateKey(key)) {
      case "intervalMinutes":
        raw.interval_minutes = parseNumber(value);
        break;
      case "openclawEnv":
        raw.openclaw_env = value;
        break;
      case "analyzerProvider":
        raw.analyzer = { ...(raw.analyzer ?? {}), provider: value };
        break;
      case "analyzerModel":
        raw.analyzer = { ...(raw.analyzer ?? {}), model: value };
        break;
      case "parsingPrompt":
        writeFileSync(cfg.promptPath, value.endsWith("\n") ? value : `${value}\n`);
        wrotePrompt = true;
        break;
      case "recordName":
        schema = { ...(schema ?? cfg.output), recordName: value };
        break;
      case "table":
        schema = { ...(schema ?? cfg.output), table: value };
        break;
      case "rootKey":
        schema = { ...(schema ?? cfg.output), rootKey: value };
        break;
      case "semanticProvider":
        raw.semantic = { ...(raw.semantic ?? {}), provider: parseSemanticProvider(value) };
        break;
      case "semanticModel":
        raw.semantic = { ...(raw.semantic ?? {}), model: value };
        break;
      case "semanticDimensions":
        raw.semantic = { ...(raw.semantic ?? {}), dimensions: parseSemanticDimensions(value) };
        break;
      default:
        throw new Error(`unsupported update key: ${key}`);
    }
  }

  writeFileSync(pollerPath, YAML.stringify(raw));
  if (schema) writeSchemaAndInit(cfg, schema);
  const updated = [
    pollerPath,
    wrotePrompt ? cfg.promptPath : null,
    schema ? cfg.schemaPath : null
  ].filter(Boolean);
  console.log(`updated ${updated.join(", ")}`);
}

function normalizeUpdateKey(key: string): string {
  const normalized = key.replace(/^--?/, "").replaceAll("_", "-").toLowerCase();
  const keys: Record<string, string> = {
    "interval": "intervalMinutes",
    "interval-minutes": "intervalMinutes",
    "openclaw-env": "openclawEnv",
    "analyzer-provider": "analyzerProvider",
    "parser-provider": "analyzerProvider",
    "analyzer-model": "analyzerModel",
    "parser-model": "analyzerModel",
    "parsing-prompt": "parsingPrompt",
    "prompt": "parsingPrompt",
    "record-name": "recordName",
    "table": "table",
    "root-key": "rootKey",
    "semantic-provider": "semanticProvider",
    "semantic-model": "semanticModel",
    "semantic-dimensions": "semanticDimensions"
  };
  return keys[normalized] ?? normalized;
}

function startPoller(slug: string, home: string): void {
  const cfg = loadPoller(slug, { home, requireSecrets: false });
  writeSystemdUnits({
    slug,
    intervalMinutes: cfg.intervalMinutes,
    home,
    cycleCommand: currentCycleCommand()
  });
  systemctl("daemon-reload");
  systemctl("enable", "--now", timerName(slug));
  console.log(`started ${timerName(slug)}`);
}

function requiredSlug(slug: string | undefined, command: string): string {
  if (!slug) throw new Error(`oni ${command} requires <slug> or --all`);
  return slug;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`expected number, got ${value}`);
  return parsed;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function homeFromProgram(): string {
  return oniHome(program.opts<{ home?: string }>().home);
}

function rewriteNamespacePollerArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  const namespaceIndex = firstPositionalIndex(args);
  if (namespaceIndex === -1) return argv;
  if (args[namespaceIndex + 1] !== "add" || args[namespaceIndex + 2] !== "poller") return argv;
  return [
    ...argv.slice(0, 2),
    ...args.slice(0, namespaceIndex),
    "add-poller",
    args[namespaceIndex],
    ...args.slice(namespaceIndex + 3)
  ];
}

function firstPositionalIndex(args: string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--home" || arg === "--log-level") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--home=") || arg.startsWith("--log-level=")) continue;
    if (arg.startsWith("-")) continue;
    return index;
  }
  return -1;
}

function readPackageVersion(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const packagePath = resolve(dirname(modulePath), "..", "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function currentCycleCommand(): string {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith(join("src", "cli.ts"))) {
    return `node --import tsx ${join(dirname(modulePath), "worker.ts")}`;
  }
  return `node ${join(dirname(modulePath), "worker.js")}`;
}

function writeSchemaAndInit(cfg: PollerConfig, schema: OutputSchema): void {
  initDb(cfg.settings.dbPath, schema);
  writeFileSync(cfg.schemaPath, formatOutputSchema(schema));
}

function parseSemanticProvider(value: string): "transformers" {
  if (value === "transformers") return value;
  throw new Error(`unsupported semantic provider: ${value}`);
}

function parseSemanticDimensions(value: string): number {
  const dimensions = parseNumber(value);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
    throw new Error(`semantic dimensions must be an integer from 1 to 4096, got ${value}`);
  }
  return dimensions;
}
