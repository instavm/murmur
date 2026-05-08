// Unit tests for src/lib/markers.mjs and src/lib/json_config.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run, eq, ok, includes } from "./_assert.mjs";
import {
  MARKER_START, MARKER_END, renderSkill, upsertMarkedSection, removeMarkedSection,
} from "../src/lib/markers.mjs";
import {
  readJson, writeJson, deepEqual, setNested, deleteNested,
} from "../src/lib/json_config.mjs";

const TMP = mkdtempSync(join(tmpdir(), "murmur-tests-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const tmpfile = (name) => join(TMP, name);

// ── markers.mjs ───────────────────────────────────────────────────────────

test("upsert creates file with markers when absent", () => {
  const f = tmpfile("a.md");
  const r = upsertMarkedSection(f, "hello body");
  eq(r.action, "created");
  const c = readFileSync(f, "utf8");
  includes(c, MARKER_START);
  includes(c, MARKER_END);
  includes(c, "hello body");
});

test("upsert updates in-place when markers exist", () => {
  const f = tmpfile("b.md");
  upsertMarkedSection(f, "v1");
  const r = upsertMarkedSection(f, "v2");
  eq(r.action, "updated");
  const c = readFileSync(f, "utf8");
  includes(c, "v2");
  ok(!c.includes("v1"), "old body should be replaced");
});

test("upsert is idempotent for same body", () => {
  const f = tmpfile("c.md");
  upsertMarkedSection(f, "stable");
  const r = upsertMarkedSection(f, "stable");
  eq(r.action, "unchanged");
});

test("upsert appends to existing file without markers, preserves user content", () => {
  const f = tmpfile("d.md");
  writeFileSync(f, "# user content\nfoo\n");
  const r = upsertMarkedSection(f, "murmur body");
  eq(r.action, "appended");
  const c = readFileSync(f, "utf8");
  includes(c, "# user content");
  includes(c, "murmur body");
  ok(c.indexOf("# user content") < c.indexOf(MARKER_START), "user content stays first");
});

test("upsert handles file ending without trailing newline", () => {
  const f = tmpfile("e.md");
  writeFileSync(f, "no trailing newline");
  upsertMarkedSection(f, "added");
  const c = readFileSync(f, "utf8");
  includes(c, "no trailing newline");
  includes(c, "added");
});

test("remove deletes marker block, keeps user content", () => {
  const f = tmpfile("f.md");
  writeFileSync(f, "# header\n\n");
  upsertMarkedSection(f, "rm me");
  const r = removeMarkedSection(f);
  eq(r.action, "removed");
  const c = readFileSync(f, "utf8");
  includes(c, "# header");
  ok(!c.includes(MARKER_START), "start marker gone");
  ok(!c.includes("rm me"), "body gone");
});

test("remove on missing file returns missing", () => {
  const r = removeMarkedSection(tmpfile("nonexistent.md"));
  eq(r.action, "missing");
});

test("remove on file without markers returns not-present", () => {
  const f = tmpfile("g.md");
  writeFileSync(f, "# only user content\n");
  const r = removeMarkedSection(f);
  eq(r.action, "not-present");
  eq(readFileSync(f, "utf8"), "# only user content\n");
});

test("upsert→remove→upsert round-trip leaves file in expected state", () => {
  const f = tmpfile("h.md");
  writeFileSync(f, "user line\n");
  upsertMarkedSection(f, "B1");
  removeMarkedSection(f);
  upsertMarkedSection(f, "B2");
  const c = readFileSync(f, "utf8");
  includes(c, "user line");
  includes(c, "B2");
  ok(!c.includes("B1"));
});

test("renderSkill substitutes <HANDLE> and <AGENT>", () => {
  const out = renderSkill({ handle: "alice", agent_type: "claude-code" });
  includes(out, "alice");
  includes(out, "claude-code");
  ok(!out.includes("<HANDLE>"), "no unsubstituted <HANDLE>");
  ok(!out.includes("<AGENT>"), "no unsubstituted <AGENT>");
});

// ── json_config.mjs ───────────────────────────────────────────────────────

test("readJson returns {} for missing file", () => {
  eq(readJson(tmpfile("missing.json")), {});
});

test("readJson returns {} for empty file", () => {
  const f = tmpfile("empty.json");
  writeFileSync(f, "");
  eq(readJson(f), {});
});

test("readJson parses valid JSON", () => {
  const f = tmpfile("v.json");
  writeFileSync(f, '{"a":1}');
  eq(readJson(f), { a: 1 });
});

test("writeJson formats with 2-space indent + trailing newline", () => {
  const f = tmpfile("w.json");
  writeJson(f, { a: { b: 1 } });
  const raw = readFileSync(f, "utf8");
  ok(raw.endsWith("\n"), "trailing newline");
  includes(raw, '  "a"');
  includes(raw, '    "b"');
});

test("setNested creates nested path on empty obj", () => {
  const o = {};
  const changed = setNested(o, "a.b.c", 42);
  eq(changed, true);
  eq(o, { a: { b: { c: 42 } } });
});

test("setNested overwrites non-object path with object", () => {
  const o = { a: 5 };
  setNested(o, "a.b", "x");
  eq(o.a.b, "x");
});

test("setNested returns false when value unchanged", () => {
  const o = { a: { b: 1 } };
  const changed = setNested(o, "a.b", 1);
  eq(changed, false);
});

test("setNested returns true when value differs", () => {
  const o = { a: { b: 1 } };
  const changed = setNested(o, "a.b", 2);
  eq(changed, true);
  eq(o.a.b, 2);
});

test("deleteNested removes existing key", () => {
  const o = { a: { b: 1, c: 2 } };
  const removed = deleteNested(o, "a.b");
  eq(removed, true);
  eq(o, { a: { c: 2 } });
});

test("deleteNested returns false when key missing", () => {
  const o = { a: {} };
  eq(deleteNested(o, "a.x"), false);
  eq(deleteNested(o, "missing.x"), false);
});

test("deepEqual basic cases", () => {
  ok(deepEqual({ a: 1 }, { a: 1 }));
  ok(!deepEqual({ a: 1 }, { a: 2 }));
  ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
  ok(deepEqual([1, 2], [1, 2]));
  ok(!deepEqual([1, 2], [2, 1]));
  ok(deepEqual(null, null));
});

await run();
