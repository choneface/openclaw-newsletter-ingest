import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "./config.js";
import type { EmailRow, EventInput } from "./db.js";

type EventList = {
  events: EventInput[];
};

export async function extractEvents(settings: Settings, prompt: string, email: EmailRow): Promise<EventInput[]> {
  const client = new Anthropic({ apiKey: settings.anthropicApiKey });
  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 4096,
    system: prompt,
    messages: [
      {
        role: "user",
        content: buildUserMessage(email)
      }
    ]
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return parseEventList(text).events;
}

function buildUserMessage(email: EmailRow): string {
  const metadata = [
    `Source: ${email.source}`,
    email.subject ? `Subject: ${email.subject}` : null,
    email.received_at ? `Received-At: ${email.received_at}` : null
  ].filter(Boolean).join("\n");

  return `Extract events from this newsletter email. Use the metadata as context for relative dates, but only extract events from the email body.

<metadata>
${metadata || "No email metadata provided."}
</metadata>

<email>
${email.raw_text ?? ""}
</email>`;
}

function parseEventList(text: string): EventList {
  try {
    return normalize(JSON.parse(text));
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Analyzer returned no JSON object");
    return normalize(JSON.parse(match[0]));
  }
}

function normalize(value: unknown): EventList {
  if (!value || typeof value !== "object" || !Array.isArray((value as { events?: unknown }).events)) {
    throw new Error("Analyzer JSON must be an object with an events array");
  }
  return { events: (value as EventList).events };
}
