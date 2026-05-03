import assert from "node:assert/strict";
import test from "node:test";
import { parseSystemdTime } from "../src/systemd.js";

test("parseSystemdTime accepts microseconds since epoch", () => {
  const usec = "1715000000000000";
  const iso = parseSystemdTime(usec);
  assert.equal(iso, new Date(1715000000000).toISOString());
});

test("parseSystemdTime accepts RFC date strings (Debian systemctl show format)", () => {
  const iso = parseSystemdTime("Sun 2026-05-03 13:39:19 UTC");
  assert.equal(iso, "2026-05-03T13:39:19.000Z");
});

test("parseSystemdTime returns null for unset values", () => {
  assert.equal(parseSystemdTime(undefined), null);
  assert.equal(parseSystemdTime(""), null);
  assert.equal(parseSystemdTime("0"), null);
  assert.equal(parseSystemdTime("n/a"), null);
});
