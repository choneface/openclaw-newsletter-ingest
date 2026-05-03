import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";
import type { Source, Settings } from "./config.js";
import { connect, insertEmail } from "./db.js";

export type PollResult = {
  source: string;
  fetched: number;
  new: number;
};

type FetchMessage = {
  uid: number | string;
  envelope?: {
    messageId?: string;
    from?: { address?: string }[];
    subject?: string;
    date?: Date;
  };
  source?: Buffer;
};

export async function pollAll(settings: Settings, sources: Source[], options: { limit?: number } = {}): Promise<PollResult[]> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    connectionTimeout: settings.imapConnectionTimeoutMs,
    greetingTimeout: settings.imapGreetingTimeoutMs,
    socketTimeout: settings.imapSocketTimeoutMs,
    auth: {
      user: settings.gmailUser,
      pass: settings.gmailAppPassword
    },
    logger: false
  });

  let imapError: Error | null = null;
  client.on("error", (error: unknown) => {
    imapError = asError(error);
  });

  try {
    await withTimeout(
      client.connect(),
      settings.imapConnectionTimeoutMs + settings.imapGreetingTimeoutMs + 5000,
      () => imapError ?? new Error("IMAP connection timed out")
    );
    await withTimeout(
      client.mailboxOpen(settings.gmailFolder),
      settings.imapSocketTimeoutMs + 5000,
      () => imapError ?? new Error(`IMAP mailbox open timed out for ${settings.gmailFolder}`)
    );
    const results: PollResult[] = [];
    for (const source of sources) {
      results.push(await pollSource(settings, source, client, options));
    }
    return results;
  } catch (error) {
    throw new Error(`IMAP poll failed: ${errorMessage(error)}`);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, errorFactory: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(errorFactory()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function errorMessage(error: unknown): string {
  const err = asError(error);
  const details = errorDetails(err);
  return [err.message || err.name || String(error) || "unknown error", details].filter(Boolean).join(" - ");
}

function errorDetails(error: Error): string {
  const withDetails = error as Error & {
    authenticationFailed?: boolean;
    code?: string;
    responseStatus?: string;
    responseText?: string;
    serverResponseCode?: string;
  };
  const parts = [
    withDetails.code ? `code=${withDetails.code}` : null,
    withDetails.responseStatus ? `status=${withDetails.responseStatus}` : null,
    withDetails.serverResponseCode ? `server=${withDetails.serverResponseCode}` : null,
    withDetails.authenticationFailed ? "authentication failed" : null,
    withDetails.responseText ?? null
  ].filter(Boolean);
  return parts.join("; ");
}

async function pollSource(settings: Settings, source: Source, client: ImapFlow, options: { limit?: number }): Promise<PollResult> {
  const uids = await searchSourceUids(client, source);
  const selected = options.limit ? uids.slice(0, options.limit) : uids;
  if (selected.length === 0) return { source: source.name, fetched: 0, new: 0 };
  let fetched = 0;
  let fresh = 0;
  const db = connect(settings.dbPath);
  try {
    for await (const msg of client.fetch(selected, { uid: true, envelope: true, source: true })) {
      fetched += 1;
      const message = msg as FetchMessage;
      const parsed = message.source ? await simpleParser(message.source) : null;
      const fromAddr = message.envelope?.from?.[0]?.address ?? parsed?.from?.value?.[0]?.address ?? null;
      const subject = message.envelope?.subject ?? parsed?.subject ?? null;
      const receivedAt = message.envelope?.date?.toISOString() ?? parsed?.date?.toISOString() ?? null;
      const messageId = message.envelope?.messageId ?? parsed?.messageId ?? `${message.uid}@${fromAddr ?? "unknown"}`;
      const rawText = parsed?.text || parsed?.html || message.source?.toString("utf8") || "";
      const rowId = insertEmail(db, {
        source: source.name,
        messageId,
        fromAddr,
        subject,
        receivedAt,
        rawText
      });
      if (rowId !== null) fresh += 1;
    }
    return { source: source.name, fetched, new: fresh };
  } finally {
    db.close();
  }
}

async function searchSourceUids(client: ImapFlow, source: Source): Promise<number[]> {
  const seen = new Set<string>();
  const uids: number[] = [];
  for (const query of source.gmailQueries) {
    const matches = (await client.search({ gmailRaw: query } as never)) || [];
    for (const uid of matches) {
      const key = String(uid);
      if (seen.has(key)) continue;
      seen.add(key);
      uids.push(uid);
    }
  }
  return uids;
}
