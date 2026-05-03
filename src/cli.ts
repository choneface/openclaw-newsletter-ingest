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
  type OutputSchema,
  type PollerConfig,
  addSource,
  formatOutputSchema,
  initPoller,
  listPollerSlugs,
  loadPoller,
  oniHome
} from "./config.js";
import { searchRecords } from "./semantic.js";
import { journalctl, serviceName, systemctl, systemctlOutput, timerName, writeSystemdUnits } from "./systemd.js";

const program = new Command();

program
  .name("oni")
  .description("OpenClaw Newsletter Ingest")
  .version(readPackageVersion())
  .option("--home <path>", "ONI home directory")
  .option("--log-level <level>", "log level");

program.command("init")
  .argument("<slug>", "poller slug")
  .description("create a poller namespace")
  .option("--interval-minutes <minutes>", "polling interval", parseNumber, 30)
  .option("--openclaw-env <path>", "path to openclaw .env")
  .option("--analyzer-provider <provider>", "analyzer provider", "anthropic")
  .option("--parsing-prompt <prompt>", "analyzer parsing prompt")
  .option("--record-name <name>", "singular name for parsed records", DEFAULT_OUTPUT_SCHEMA.recordName)
  .option("--table <name>", "SQLite table for parsed records", DEFAULT_OUTPUT_SCHEMA.table)
  .option("--root-key <key>", "top-level JSON array key expected from the analyzer", DEFAULT_OUTPUT_SCHEMA.rootKey)
  .option("--semantic-provider <provider>", "semantic embedding provider", DEFAULT_SEMANTIC_CONFIG.provider)
  .option("--semantic-model <model>", "semantic embedding model", DEFAULT_SEMANTIC_CONFIG.model)
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseSemanticDimensions, DEFAULT_SEMANTIC_CONFIG.dimensions)
  .option("--force", "overwrite existing template files")
  .action((slug, options) => {
    const home = homeFromProgram();
    const schema = defaultSchemaWith({
      recordName: options.recordName,
      table: options.table,
      rootKey: options.rootKey
    });
    const root = initPoller({
      slug,
      home,
      intervalMinutes: options.intervalMinutes,
      openclawEnv: options.openclawEnv,
      analyzerProvider: options.analyzerProvider,
      prompt: options.parsingPrompt,
      semantic: {
        provider: parseSemanticProvider(options.semanticProvider),
        model: options.semanticModel,
        dimensions: options.semanticDimensions
      },
      schema,
      force: Boolean(options.force)
    });
    initDb(resolve(root, "newsletters.db"), schema);
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
  .description("show poller timer and pipeline status")
  .action((slug, options) => {
    const home = homeFromProgram();
    const render = () => {
      if (options.watch) process.stdout.write("\x1Bc");
      const slugs = slug ? [slug] : listPollerSlugs(home);
      for (const selected of slugs) console.log(formatStatus(selected, home));
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

function formatStatus(slug: string, home: string): string {
  const cfg = loadPoller(slug, { home, requireSecrets: false });
  const timer = systemctlOutput("is-active", timerName(slug));
  const service = systemctlOutput("is-active", serviceName(slug));
  const next = systemctlOutput("show", timerName(slug), "--property=NextElapseUSecRealtime", "--value");
  const db = connect(cfg.settings.dbPath);
  try {
    const emails = scalar(db, "SELECT COUNT(*) FROM emails");
    const pending = scalar(db, "SELECT COUNT(*) FROM emails WHERE parsed_at IS NULL");
    const failed = scalar(db, "SELECT COUNT(*) FROM emails WHERE parse_error IS NOT NULL");
    const records = scalar(db, `SELECT COUNT(*) FROM "${cfg.output.table}"`);
    const embedded = tableExists(db, "semantic_items")
      ? scalar(db, "SELECT COUNT(*) FROM semantic_items WHERE target_type = 'record' AND target_table = ? AND model = ?", [cfg.output.table, cfg.semantic.model])
      : 0;
    return [
      `${slug}`,
      `  timer=${timer} service=${service} next=${next || "unknown"}`,
      `  emails=${emails} pending=${pending} failed=${failed} records=${records} embedded=${embedded}`
    ].join("\n");
  } finally {
    db.close();
  }
}

function scalar(db: ReturnType<typeof connect>, sql: string, params: unknown[] = []): number {
  try {
    const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    const value = row ? Object.values(row)[0] : 0;
    return Number(value ?? 0);
  } catch {
    return 0;
  }
}

function tableExists(db: ReturnType<typeof connect>, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
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

function defaultSchemaWith(overrides: Pick<OutputSchema, "recordName" | "table" | "rootKey">): OutputSchema {
  const usesDefaultNames = overrides.recordName === DEFAULT_OUTPUT_SCHEMA.recordName
    && overrides.table === DEFAULT_OUTPUT_SCHEMA.table
    && overrides.rootKey === DEFAULT_OUTPUT_SCHEMA.rootKey;
  if (usesDefaultNames) return DEFAULT_OUTPUT_SCHEMA;
  return {
    recordName: overrides.recordName,
    table: overrides.table,
    rootKey: overrides.rootKey,
    columns: [
      { name: "title", type: "text", required: true, index: false },
      { name: "summary", type: "text", required: false, index: false },
      { name: "link", type: "text", required: false, index: false },
      { name: "tags", type: "json", required: false, index: false }
    ]
  };
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
