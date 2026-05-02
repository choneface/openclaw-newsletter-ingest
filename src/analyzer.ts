import Anthropic from "@anthropic-ai/sdk";
import type { OutputSchema, Settings } from "./config.js";
import type { EmailRow, RecordInput } from "./db.js";

export async function extractRecords(provider: string, settings: Settings, prompt: string, output: OutputSchema, email: EmailRow): Promise<RecordInput[]> {
  if (provider === "mock") return [];
  if (provider !== "anthropic") throw new Error(`unsupported analyzer provider: ${provider}`);

  const client = new Anthropic({ apiKey: settings.anthropicApiKey });
  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 4096,
    system: prompt,
    messages: [
      {
        role: "user",
        content: buildUserMessage(email, output)
      }
    ]
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return parseRecordList(text, output);
}

function buildUserMessage(email: EmailRow, output: OutputSchema): string {
  const metadata = [
    `Source: ${email.source}`,
    email.subject ? `Subject: ${email.subject}` : null,
    email.received_at ? `Received-At: ${email.received_at}` : null
  ].filter(Boolean).join("\n");

  return `Extract ${output.recordName} records from this newsletter email. Use the metadata as context for relative dates, but only extract records from the email body.

Return only JSON with this top-level shape:
{
  "${output.rootKey}": [
    {
${output.columns.map((column) => `      "${column.name}": ${columnDescription(column.type, column.required)}`).join(",\n")}
    }
  ]
}

<metadata>
${metadata || "No email metadata provided."}
</metadata>

<email>
${email.raw_text ?? ""}
</email>`;
}

function parseRecordList(text: string, output: OutputSchema): RecordInput[] {
  try {
    return normalize(JSON.parse(text), output);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Analyzer returned no JSON object");
    return normalize(JSON.parse(match[0]), output);
  }
}

function normalize(value: unknown, output: OutputSchema): RecordInput[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>)[output.rootKey])) {
    throw new Error(`Analyzer JSON must be an object with a ${output.rootKey} array`);
  }
  return ((value as Record<string, unknown>)[output.rootKey] as unknown[]).map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Analyzer ${output.rootKey} array must contain objects`);
    }
    return record as RecordInput;
  });
}

function columnDescription(type: string, required: boolean): string {
  const nullable = required ? "required" : "optional, null if absent";
  if (type === "json") return `array/object/string/number/boolean (${nullable})`;
  return `${type} (${nullable})`;
}
