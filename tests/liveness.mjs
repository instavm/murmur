// Unit tests for src/lib/liveness.mjs — pure functions, no daemon needed.
import { classify, liveness, fmtAge, FRESH_MAX_S, STALE_MAX_S } from "../src/lib/liveness.mjs";
import { test, run, eq, ok } from "./_assert.mjs";

const NOW = Date.parse("2026-05-08T12:00:00.000Z");
const at = (offsetS) => new Date(NOW - offsetS * 1000).toISOString();

test("classify: fresh just below threshold", () => {
  const r = classify(at(FRESH_MAX_S - 1), NOW);
  eq(r.status, "fresh");
  eq(r.ageS, FRESH_MAX_S - 1);
});

test("classify: fresh exactly at threshold (inclusive)", () => {
  const r = classify(at(FRESH_MAX_S), NOW);
  eq(r.status, "fresh");
});

test("classify: stale just above fresh threshold", () => {
  const r = classify(at(FRESH_MAX_S + 1), NOW);
  eq(r.status, "stale");
});

test("classify: stale exactly at stale threshold (inclusive)", () => {
  const r = classify(at(STALE_MAX_S), NOW);
  eq(r.status, "stale");
});

test("classify: dead above stale threshold", () => {
  const r = classify(at(STALE_MAX_S + 1), NOW);
  eq(r.status, "dead");
});

test("classify: missing last_seen → unknown, ageS null", () => {
  const r = classify(null, NOW);
  eq(r.status, "unknown");
  eq(r.ageS, null);
});

test("classify: future timestamp (clock skew) → ageS clamped to 0, fresh", () => {
  const r = classify(new Date(NOW + 60_000).toISOString(), NOW);
  eq(r.ageS, 0);
  eq(r.status, "fresh");
});

test("liveness: maps participants and preserves handle/agent_type", () => {
  const rows = liveness(
    [
      { handle: "alice", agent_type: "claude-code", last_seen: at(10) },
      { handle: "bob", agent_type: "codex-cli", last_seen: at(120) },
      { handle: "carol", agent_type: "gemini-cli", last_seen: at(9999) },
    ],
    NOW,
  );
  eq(rows.length, 3);
  eq(rows[0].handle, "alice");
  eq(rows[0].agent_type, "claude-code");
  eq(rows[0].status, "fresh");
  eq(rows[1].status, "stale");
  eq(rows[2].status, "dead");
});

test("fmtAge: seconds / minutes / hours boundaries", () => {
  eq(fmtAge(0), "0s");
  eq(fmtAge(59), "59s");
  eq(fmtAge(60), "1m0s");
  eq(fmtAge(125), "2m5s");
  eq(fmtAge(3600), "1h0m");
  eq(fmtAge(7325), "2h2m");
  eq(fmtAge(null), "—");
});

await run();
