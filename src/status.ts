import { connect } from "./db.js";
import { loadPoller, loadSources, type Source } from "./config.js";
import {
  parseSystemdUsec,
  serviceName,
  systemctlShow,
  timerName
} from "./systemd.js";

export type SourceStatus = {
  name: string;
  configured: boolean;
  enabled: boolean;
  queries: string[];
  description: string;
  emails: number;
  failed: number;
  last_fetched_at: string | null;
  last_subject: string | null;
  last_error: string | null;
};

export type PollerStatus = {
  namespace: string;
  health: "ok" | "warn" | "error";
  notes: string[];
  interval_minutes: number;
  timer: {
    state: string;
    next_run_at: string | null;
    last_run_at: string | null;
  };
  service: {
    state: string;
    last_result: string | null;
    last_exit_code: number | null;
    last_started_at: string | null;
    last_finished_at: string | null;
  };
  pipeline: {
    emails: number;
    pending: number;
    failed: number;
    records: number;
    embedded: number;
  };
  pollers: SourceStatus[];
};

export function collectStatus(slug: string, home: string): PollerStatus {
  const cfg = loadPoller(slug, { home, requireSecrets: false });
  const timer = collectTimerStatus(slug);
  const service = collectServiceStatus(slug);
  const sources = safeLoadSources(cfg.sourcesPath);

  const db = connect(cfg.settings.dbPath);
  try {
    const pipeline = {
      emails: scalar(db, "SELECT COUNT(*) FROM emails"),
      pending: scalar(db, "SELECT COUNT(*) FROM emails WHERE parsed_at IS NULL"),
      failed: scalar(db, "SELECT COUNT(*) FROM emails WHERE parse_error IS NOT NULL"),
      records: scalar(db, `SELECT COUNT(*) FROM "${cfg.output.table}"`),
      embedded: tableExists(db, "semantic_items")
        ? scalar(
            db,
            "SELECT COUNT(*) FROM semantic_items WHERE target_type = 'record' AND target_table = ? AND model = ?",
            [cfg.output.table, cfg.semantic.model]
          )
        : 0
    };
    const pollers = collectPollerSources(db, sources);
    const status: PollerStatus = {
      namespace: slug,
      health: "ok",
      notes: [],
      interval_minutes: cfg.intervalMinutes,
      timer,
      service,
      pipeline,
      pollers
    };
    applyHealth(status);
    return status;
  } finally {
    db.close();
  }
}

export function formatStatusText(status: PollerStatus): string {
  const lines: string[] = [];
  lines.push(`${status.namespace}  [${status.health}]`);
  for (const note of status.notes) lines.push(`  ! ${note}`);
  lines.push(`  interval: ${status.interval_minutes}m`);
  lines.push(`  timer:    ${status.timer.state}  next=${status.timer.next_run_at ?? "-"}  last=${status.timer.last_run_at ?? "-"}`);
  lines.push(`  service:  ${status.service.state}  last_result=${status.service.last_result ?? "-"}  exit=${status.service.last_exit_code ?? "-"}  last_finished=${status.service.last_finished_at ?? "-"}`);
  lines.push(`  pipeline: emails=${status.pipeline.emails} pending=${status.pipeline.pending} failed=${status.pipeline.failed} records=${status.pipeline.records} embedded=${status.pipeline.embedded}`);
  if (status.pollers.length > 0) {
    lines.push(`  pollers:`);
    const nameWidth = Math.min(24, Math.max(...status.pollers.map((entry) => entry.name.length)));
    for (const poller of status.pollers) {
      const flags = [
        poller.configured ? null : "orphan",
        poller.configured && !poller.enabled ? "disabled" : null
      ].filter(Boolean).join(",");
      const marker = flags ? ` [${flags}]` : "";
      const subject = poller.last_subject ? ` "${truncate(poller.last_subject, 60)}"` : "";
      const errorTag = poller.last_error ? `  err=${truncate(poller.last_error, 40)}` : "";
      lines.push(`    ${poller.name.padEnd(nameWidth)}  emails=${poller.emails} failed=${poller.failed} last_fetched=${poller.last_fetched_at ?? "-"}${subject}${errorTag}${marker}`);
    }
  }
  return lines.join("\n");
}

function collectTimerStatus(slug: string): PollerStatus["timer"] {
  const props = systemctlShow(timerName(slug));
  const loaded = props.LoadState && props.LoadState !== "not-found";
  return {
    state: loaded ? (props.ActiveState || "unknown") : "not-installed",
    next_run_at: parseSystemdUsec(props.NextElapseUSecRealtime),
    last_run_at: parseSystemdUsec(props.LastTriggerUSec)
  };
}

function collectServiceStatus(slug: string): PollerStatus["service"] {
  const props = systemctlShow(serviceName(slug));
  const loaded = props.LoadState && props.LoadState !== "not-found";
  const exit = props.ExecMainStatus !== undefined && props.ExecMainStatus !== "" ? Number(props.ExecMainStatus) : null;
  return {
    state: loaded ? (props.ActiveState || "unknown") : "not-installed",
    last_result: props.Result || null,
    last_exit_code: Number.isFinite(exit) ? (exit as number) : null,
    last_started_at: parseRfcTimestamp(props.ExecMainStartTimestamp),
    last_finished_at: parseRfcTimestamp(props.ExecMainExitTimestamp)
  };
}

function collectPollerSources(db: ReturnType<typeof connect>, sources: Source[]): SourceStatus[] {
  const aggregates = new Map<string, { count: number; failed: number; last_fetched: string | null }>();
  try {
    const rows = db.prepare(`SELECT source,
        COUNT(*) AS count,
        SUM(CASE WHEN parse_error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
        MAX(fetched_at) AS last_fetched
      FROM emails GROUP BY source`).all() as Array<{ source: string; count: number; failed: number; last_fetched: string | null }>;
    for (const row of rows) {
      aggregates.set(row.source, {
        count: Number(row.count) || 0,
        failed: Number(row.failed) || 0,
        last_fetched: row.last_fetched
      });
    }
  } catch {
    // emails table may not exist yet
  }

  const result: SourceStatus[] = sources.map((source) => buildSourceStatus(db, source.name, aggregates.get(source.name), source));
  for (const [name, agg] of aggregates) {
    if (sources.some((source) => source.name === name)) continue;
    result.push(buildSourceStatus(db, name, agg, null));
  }
  return result;
}

function buildSourceStatus(
  db: ReturnType<typeof connect>,
  name: string,
  aggregate: { count: number; failed: number; last_fetched: string | null } | undefined,
  configured: Source | null
): SourceStatus {
  const counts = aggregate ?? { count: 0, failed: 0, last_fetched: null };
  const latest = lastEmailMeta(db, name);
  return {
    name,
    configured: configured !== null,
    enabled: configured?.enabled ?? false,
    queries: configured?.gmailQueries ?? [],
    description: configured?.description ?? "",
    emails: counts.count,
    failed: counts.failed,
    last_fetched_at: counts.last_fetched,
    last_subject: latest?.subject ?? null,
    last_error: latest?.parse_error ?? null
  };
}

function lastEmailMeta(db: ReturnType<typeof connect>, source: string): { subject: string | null; parse_error: string | null } | null {
  try {
    const row = db.prepare("SELECT subject, parse_error FROM emails WHERE source = ? ORDER BY id DESC LIMIT 1").get(source) as
      | { subject: string | null; parse_error: string | null }
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function applyHealth(status: PollerStatus): void {
  const notes: string[] = [];
  let health: PollerStatus["health"] = "ok";

  if (status.timer.state === "not-installed") {
    health = worse(health, "error");
    notes.push(`timer is not installed; run \`oni start ${status.namespace}\``);
  } else if (status.timer.state !== "active") {
    health = worse(health, "error");
    notes.push(`timer state is "${status.timer.state}"; run \`oni start ${status.namespace}\``);
  }

  if (status.service.last_result && status.service.last_result !== "success") {
    health = worse(health, "error");
    notes.push(`last service run reported "${status.service.last_result}" (exit ${status.service.last_exit_code ?? "?"}); see \`oni logs ${status.namespace}\``);
  }

  if (status.pipeline.failed > 0) {
    health = worse(health, "warn");
    notes.push(`${status.pipeline.failed} email(s) failed to parse; see \`oni logs ${status.namespace}\``);
  }

  for (const poller of status.pollers) {
    if (!poller.configured) {
      health = worse(health, "warn");
      notes.push(`source "${poller.name}" exists in DB but is not configured in sources.yaml`);
      continue;
    }
    if (!poller.enabled) continue;
    if (status.timer.last_run_at && poller.emails === 0) {
      health = worse(health, "warn");
      notes.push(`poller "${poller.name}" has 0 emails after at least one run; verify gmail_query`);
    }
  }

  status.health = health;
  status.notes = notes;
}

function worse(current: PollerStatus["health"], next: PollerStatus["health"]): PollerStatus["health"] {
  const order = { ok: 0, warn: 1, error: 2 };
  return order[next] > order[current] ? next : current;
}

function safeLoadSources(path: string): Source[] {
  try {
    return loadSources(path);
  } catch {
    return [];
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

function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

function parseRfcTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  if (value === "0" || value === "n/a") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}
