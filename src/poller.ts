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
    auth: {
      user: settings.gmailUser,
      pass: settings.gmailAppPassword
    },
    logger: false
  });

  await client.connect();
  try {
    await client.mailboxOpen(settings.gmailFolder);
    const results: PollResult[] = [];
    for (const source of sources) {
      results.push(await pollSource(settings, source, client, options));
    }
    return results;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function pollSource(settings: Settings, source: Source, client: ImapFlow, options: { limit?: number }): Promise<PollResult> {
  const uids = (await client.search({ gmailRaw: source.gmailQuery } as never)) || [];
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
