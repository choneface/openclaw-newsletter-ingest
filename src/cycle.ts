import { connect, insertRecords, markEmailFailed, markEmailParsed, unparsedEmails } from "./db.js";
import { loadPoller, loadSources, readPrompt, type PollerConfig } from "./config.js";
import { pollAll } from "./poller.js";
import { extractRecords } from "./analyzer.js";
import { indexRecords } from "./semantic.js";

export async function runPollerCycle(slug: string, home: string): Promise<void> {
  const { cfg, sources, prompt } = runtime(slug, home);
  const results = await pollAll(cfg.settings, sources);
  for (const result of results) console.log(`${result.source}: fetched=${result.fetched} new=${result.new}`);
  await parse(cfg, prompt, { retryFailed: false });
  await index(cfg, { rebuild: false });
}

function runtime(slug: string, home: string) {
  const cfg = loadPoller(slug, { home });
  if (!["anthropic", "mock"].includes(cfg.provider)) throw new Error(`unsupported analyzer provider: ${cfg.provider}`);
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
        const records = await extractRecords(cfg.provider, cfg.settings, prompt, cfg.output, row);
        const count = insertRecords(db, cfg.output, row.id, row.source, records);
        markEmailParsed(db, row.id);
        parsed += 1;
        console.log(`  email#${row.id} (${row.source}): ${count} ${cfg.output.rootKey}`);
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

async function index(cfg: PollerConfig, options: { limit?: number; rebuild: boolean }): Promise<void> {
  const db = connect(cfg.settings.dbPath);
  try {
    const result = await indexRecords(db, cfg.output, cfg.semantic, options);
    console.log(`indexed=${result.indexed} skipped=${result.skipped}`);
  } finally {
    db.close();
  }
}
