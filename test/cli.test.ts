import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("oni init and query work through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", "demo"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const query = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "query", "demo"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(query.trim(), "[]");
});
