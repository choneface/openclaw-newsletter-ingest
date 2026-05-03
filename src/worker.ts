#!/usr/bin/env node
import { oniHome } from "./config.js";
import { runPollerCycle } from "./cycle.js";

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { home, slug } = parseArgs(process.argv.slice(2));
  await runPollerCycle(slug, oniHome(home));
}

function parseArgs(args: string[]): { home?: string; slug: string } {
  let home: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--home") {
      const value = args[i + 1];
      if (!value) throw new Error("--home requires a path");
      home = value;
      i += 1;
    } else if (arg.startsWith("--home=")) {
      home = arg.slice("--home=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unsupported worker option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  const [slug] = positionals;
  if (!slug || positionals.length > 1) throw new Error("usage: oni-worker [--home <path>] <namespace>");
  return { home, slug };
}
