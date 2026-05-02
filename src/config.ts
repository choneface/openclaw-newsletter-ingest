import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";

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
  intervalMinutes: number;
  provider: string;
};

export const DEFAULT_PROMPT = `You extract NYC events from newsletter emails.

Read the email and return a JSON object with an "events" array. Each event
should have a name and as many of the optional fields as the email actually
specifies. Leave a field null if it is not mentioned. Do not invent details.

Dates: convert relative dates like "this Saturday" to ISO YYYY-MM-DD using
the email's received-at date as the reference point if provided.

Neighborhood: only fill in if the email names a NYC neighborhood explicitly
or via a venue you are highly confident about.

Tags: choose from a small open vocabulary like music, food, art, outdoor,
nightlife, family, theater, film, talk, market, festival, free, ticketed.

If the email contains no actual events, return {"events": []}.
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

function resolvePollerPath(root: string, value: string): string {
  const expanded = value.replace(/^~(?=$|\/)/, homedir());
  return isAbsolute(expanded) ? expanded : join(root, expanded);
}
