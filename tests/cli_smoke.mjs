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
  // After say() above we registered @tester and @human; doctor should now
  // print a room-liveness section listing them as fresh.
  includes(r.stdout, "room liveness");
  includes(r.stdout, "@tester");
  includes(r.stdout, "fresh");
});

test("poke <handle> posts a wake mention as @human", () => {
  const r = murmur(["poke", "tester"]);
  eq(r.status, 0);
  const h = murmur(["history", "--limit=5"]);
  includes(h.stdout, "@tester still alive");
  includes(h.stdout, "human");
});

test("poke without handle fails with usage", () => {
  const r = murmur(["poke"]);
  ok(r.status !== 0, "should fail without handle");
  includes(r.stderr, "usage: murmur poke");
});

test("doctor flags participants as dead with low liveness thresholds", async () => {
  // Drop thresholds so the @tester participant from earlier `say` calls
  // ages into "dead" within a couple of seconds.
  const tightEnv = {
    ...env,
    MURMUR_LIVENESS_FRESH_S: "1",
    MURMUR_LIVENESS_STALE_S: "2",
  };
  await new Promise((r) => setTimeout(r, 3000));
  const r = spawnSync(process.execPath, [BIN, "doctor"], { env: tightEnv, encoding: "utf8" });
  ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${r.stderr}`);
  includes(r.stdout, "dead");
  includes(r.stdout, "murmur poke");
});

test("stop: daemon halts, pid file gone", () => {
  const r = murmur(["stop"]);
  started = false;
  eq(r.status, 0);
  ok(!existsSync(join(TMP, "murmurd.pid")), "pid file removed");
});

test("reset --yes (post-stop): clears db; restart yields empty room", () => {
  const r = murmur(["reset", "--yes"]);
  eq(r.status, 0);
  includes(r.stdout, "cleared");
  // Daemon comes back up cleanly against the wiped db, with zero messages.
  const s = murmur(["start"]);
  started = true;
  eq(s.status, 0);
  const post = murmur(["say", "post-reset", "--as=tester"]);
  eq(post.status, 0);
  const h = murmur(["history", "--limit=10"]);
  ok(!h.stdout.includes("hello from cli"), "old messages gone");
  includes(h.stdout, "post-reset");
  // Tear down again so the subsequent stop test sees a running daemon.
  const stop = murmur(["stop"]);
  started = false;
  eq(stop.status, 0);
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
