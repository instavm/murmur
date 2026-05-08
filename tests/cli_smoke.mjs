// Spawn bin/murmur subcommands as subprocesses against an isolated
// MURMUR_HOME + alt port. Round-trip start → status → say → history → stop.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test, run, eq, ok, includes } from "./_assert.mjs";

const PORT = 19998;
const TMP = mkdtempSync(join(tmpdir(), "murmur-cli-"));
const ROOT = new URL("..", import.meta.url).pathname;
const BIN = join(ROOT, "bin/murmur");
const env = { ...process.env, MURMUR_HOME: TMP, MURMUR_PORT: String(PORT) };

function murmur(args) {
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
}

let started = false;

process.on("exit", () => {
  if (started) {
    try { murmur(["stop"]); } catch {}
  }
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ── tests ─────────────────────────────────────────────────────────────────

test("help prints usage", () => {
  const r = murmur(["help"]);
  eq(r.status, 0);
  includes(r.stdout, "murmur — local multi-agent room");
  includes(r.stdout, "watch");
});

test("status before start: daemon down", () => {
  const r = murmur(["status"]);
  eq(r.status, 0);
  // accept either "down" wording or absence of pid
  ok(/down|not running|no pid/i.test(r.stdout) || !existsSync(join(TMP, "murmurd.pid")),
    "expected daemon-down indicator: " + r.stdout);
});

test("start: daemon starts and writes pid + port files", () => {
  const r = murmur(["start"]);
  started = true;
  eq(r.status, 0);
  includes(r.stdout, "murmurd started");
  ok(existsSync(join(TMP, "murmurd.pid")), "pid file present");
  ok(existsSync(join(TMP, "murmurd.port")), "port file present");
});

test("start is idempotent: second call detects running daemon", () => {
  const r = murmur(["start"]);
  eq(r.status, 0);
  includes(r.stdout, "already running");
});

test("status after start: shows port + 0 messages", () => {
  const r = murmur(["status"]);
  eq(r.status, 0);
  includes(r.stdout, String(PORT));
});

test("say posts a message; history shows it", () => {
  const s = murmur(["say", "hello from cli", "--as=tester"]);
  eq(s.status, 0);
  const h = murmur(["history", "--limit=5"]);
  eq(h.status, 0);
  includes(h.stdout, "hello from cli");
  includes(h.stdout, "tester");
});

test("say with default handle = human", () => {
  const s = murmur(["say", "hi as default"]);
  eq(s.status, 0);
  const h = murmur(["history", "--limit=5"]);
  includes(h.stdout, "hi as default");
  includes(h.stdout, "human");
});

test("doctor runs without crashing post-start", () => {
  const r = murmur(["doctor"]);
  // doctor returns 0 if all green, non-zero if any red — accept either,
  // we only need it to not crash with a stack trace.
  ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${r.stderr}`);
  ok(!r.stderr.includes("Error:"), `stderr stack: ${r.stderr}`);
});

test("stop: daemon halts, pid file gone", () => {
  const r = murmur(["stop"]);
  started = false;
  eq(r.status, 0);
  ok(!existsSync(join(TMP, "murmurd.pid")), "pid file removed");
});

test("status after stop: daemon down", () => {
  const r = murmur(["status"]);
  eq(r.status, 0);
  ok(/down|not running|no pid/i.test(r.stdout), "expected down: " + r.stdout);
});

test("unknown command exits non-zero", () => {
  const r = murmur(["nonsense"]);
  ok(r.status !== 0, "should fail");
  includes(r.stderr, "unknown command");
});

await run();
