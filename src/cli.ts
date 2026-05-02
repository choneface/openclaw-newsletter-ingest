#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { connect, initDb, insertEvents, markEmailFailed, markEmailParsed, queryEvents, unparsedEmails } from "./db.js";
import { type PollerConfig, initPoller, loadPoller, loadSources, oniHome, readPrompt } from "./config.js";
import { pollAll } from "./poller.js";
import { extractEvents } from "./analyzer.js";
import { journalctl, serviceName, systemctl, timerName, writeSystemdUnits } from "./systemd.js";

const program = new Command();

program
  .name("oni")
  .description("OpenClaw Newsletter Ingest")
  .option("--home <path>", "ONI home directory")
  .option("--log-level <level>", "log level");

program.command("init")
  .argument("<slug>", "poller slug")
  .option("--interval-minutes <minutes>", "polling interval", parseNumber, 30)
  .option("--openclaw-env <path>", "path to openclaw .env")
  .option("--force", "overwrite existing template files")
  .action((slug, options) => {
    const home = homeFromProgram();
    const root = initPoller({
      slug,
      home,
      intervalMinutes: options.intervalMinutes,
      openclawEnv: options.openclawEnv,
      force: Boolean(options.force)
    });
    initDb(resolve(root, "newsletters.db"));
    console.log(`created ${root}`);
    console.log(`edit ${resolve(root, "poller.yaml")}`);
    console.log(`edit ${resolve(root, "sources.yaml")}`);
    console.log(`edit ${resolve(root, "prompt.md")}`);
  });

program.command("sources")
  .argument("<slug>", "poller slug")
  .action((slug) => {
    const cfg = loadPoller(slug, { home: homeFromProgram(), requireSecrets: false });
    for (const source of loadSources(cfg.sourcesPath)) {
      console.log(`${source.name.padEnd(20)} ${source.parser.padEnd(25)} ${source.gmailQuery}`);
    }
  });

program.command("poll")
  .argument("<slug>", "poller slug")
  .option("--source <name>", "only poll one source")
  .option("--limit <n>", "max emails per source", parseNumber)
  .action(async (slug, options) => {
    const { cfg, sources } = runtime(slug);
    const selected = options.source ? sources.filter((source) => source.name === options.source) : sources;
    if (options.source && selected.length === 0) throw new Error(`no source named ${options.source}`);
    const results = await pollAll(cfg.settings, selected, { limit: options.limit });
    for (const result of results) console.log(`${result.source}: fetched=${result.fetched} new=${result.new}`);
  });

program.command("parse")
  .argument("<slug>", "poller slug")
  .option("--limit <n>", "max emails to parse", parseNumber)
  .option("--retry-failed", "retry emails with parse errors")
  .action(async (slug, options) => {
    const { cfg, prompt } = runtime(slug);
    await parse(cfg, prompt, { limit: options.limit, retryFailed: Boolean(options.retryFailed) });
  });

program.command("run")
  .argument("<slug>", "poller slug")
  .option("--once", "run one poll + parse cycle")
  .option("--source <name>", "only poll one source")
  .option("--limit <n>", "limit emails", parseNumber)
  .option("--retry-failed", "retry emails with parse errors")
  .action(async (slug, options) => {
    if (!options.once) throw new Error("oni run currently executes one cycle; pass --once to be explicit");
    const { cfg, sources, prompt } = runtime(slug);
    const selected = options.source ? sources.filter((source) => source.name === options.source) : sources;
    if (options.source && selected.length === 0) throw new Error(`no source named ${options.source}`);
    const results = await pollAll(cfg.settings, selected, { limit: options.limit });
    for (const result of results) console.log(`${result.source}: fetched=${result.fetched} new=${result.new}`);
    await parse(cfg, prompt, { limit: options.limit, retryFailed: Boolean(options.retryFailed) });
  });

program.command("query")
  .argument("<slug>", "poller slug")
  .option("--from <date>", "start date")
  .option("--to <date>", "end date")
  .option("--source <name>", "source name")
  .option("--neighborhood <name>", "neighborhood")
  .option("--limit <n>", "max rows", parseNumber, 100)
  .action((slug, options) => {
    const cfg = loadPoller(slug, { home: homeFromProgram(), requireSecrets: false });
    const db = connect(cfg.settings.dbPath);
    try {
      console.log(JSON.stringify(queryEvents(db, {
        dateFrom: options.from,
        dateTo: options.to,
        source: options.source,
        neighborhood: options.neighborhood,
        limit: options.limit
      }), null, 2));
    } finally {
      db.close();
    }
  });

program.command("start")
  .argument("<slug>", "poller slug")
  .action((slug) => {
    const home = homeFromProgram();
    const cfg = loadPoller(slug, { home, requireSecrets: false });
    writeSystemdUnits({
      slug,
      intervalMinutes: cfg.intervalMinutes,
      home,
      oniBin: currentOniBin()
    });
    systemctl("daemon-reload");
    systemctl("enable", "--now", timerName(slug));
    console.log(`started ${timerName(slug)}`);
  });

program.command("stop")
  .argument("<slug>", "poller slug")
  .action((slug) => {
    systemctl("disable", "--now", timerName(slug));
    console.log(`stopped ${timerName(slug)}`);
  });

program.command("status")
  .argument("<slug>", "poller slug")
  .action((slug) => systemctl("status", timerName(slug), "--no-pager"));

program.command("logs")
  .argument("<slug>", "poller slug")
  .option("-f, --follow", "follow logs")
  .option("-n, --lines <n>", "lines to show", parseNumber, 100)
  .action((slug, options) => {
    const args = ["-u", serviceName(slug), "--no-pager", "-n", String(options.lines)];
    if (options.follow) args.push("-f");
    journalctl(args);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function runtime(slug: string) {
  const cfg = loadPoller(slug, { home: homeFromProgram() });
  if (cfg.provider !== "anthropic") throw new Error(`unsupported analyzer provider: ${cfg.provider}`);
  return {
    cfg,
    sources: loadSources(cfg.sourcesPath),
    prompt: readPrompt(cfg.promptPath)
  };
}

async function parse(cfg: PollerConfig, prompt: string, options: { limit?: number; retryFailed: boolean }): Promise<void> {
  const db = connect(cfg.settings.dbPath);
  let parsed = 0;
  let failed = 0;
  try {
    const rows = unparsedEmails(db, options);
    for (const row of rows) {
      try {
        const events = await extractEvents(cfg.settings, prompt, row);
        const count = insertEvents(db, row.id, row.source, events);
        markEmailParsed(db, row.id);
        parsed += 1;
        console.log(`  email#${row.id} (${row.source}): ${count} events`);
      } catch (error) {
        markEmailFailed(db, row.id, error instanceof Error ? error.message : String(error));
        failed += 1;
        console.error(`  email#${row.id} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    db.close();
  }
  console.log(`parsed=${parsed} failed=${failed}`);
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`expected number, got ${value}`);
  return parsed;
}

function homeFromProgram(): string {
  return oniHome(program.opts<{ home?: string }>().home);
}

function currentOniBin(): string {
  const argvBin = process.argv[1] ? resolve(process.argv[1]) : "";
  if (argvBin && existsSync(argvBin) && !argvBin.endsWith("src/cli.ts")) return argvBin;
  return "oni";
}
