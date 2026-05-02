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

test("oni schema commands configure parsed output through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "oni-cli-"));
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "init", "deals", "--record-name", "deal", "--table", "deals", "--root-key", "deals"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "schema-add-column", "deals", "company", "--type", "text", "--index"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const schema = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--home", home, "schema", "deals"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.match(schema, /table: deals/);
  assert.match(schema, /name: company/);
});
