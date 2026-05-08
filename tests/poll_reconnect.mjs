// Reconnect regression: simulates the failure mode that motivated the v1
// "robust to sleep / network drop" rule in the Skill. We prove that an agent
// whose MCP session-id is dead can recover end-to-end by:
//   1. closing its current transport (mimicking the SDK after sleep/wake),
//   2. opening a new transport (new session-id),
//   3. calling register() again with the same handle,
//   4. resuming poll() with its last cursor,
// and that NO mentions posted during the gap are lost.
//
// This is the test that locks in the empirical finding from
// scripts/sleep_recovery.mjs: protocol-level recovery is sound; the Skill
// rule "on error → wait 2s → re-register → resume" is sufficient.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, run, eq, ok } from "./_assert.mjs";

const PORT = 19996;
const TMP = mkdtempSync(join(tmpdir(), "murmur-recon-"));
const env = { ...process.env, MURMUR_HOME: TMP, MURMUR_PORT: String(PORT) };
const ROOT = new URL("..", import.meta.url).pathname;

const daemon = spawn(process.execPath, [join(ROOT, "src/daemon/murmurd.mjs"), `--port=${PORT}`], {
  env, stdio: ["ignore", "pipe", "pipe"],
});
let daemonOut = "";
daemon.stdout.on("data", (b) => { daemonOut += b.toString(); });
daemon.stderr.on("data", (b) => { daemonOut += b.toString(); });

async function waitForReady(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(join(TMP, "murmurd.port"))) return;
    if (daemon.exitCode !== null) throw new Error(`daemon died: ${daemonOut}`);
    await delay(50);
  }
  throw new Error(`daemon did not start within ${timeoutMs}ms: ${daemonOut}`);
}

async function newClient(label) {
  const url = new URL(`http://localhost:${PORT}/mcp/${label}`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: `recon-${label}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
async function call(c, name, args) {
  const res = await c.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

await waitForReady();
process.on("exit", () => { try { daemon.kill("SIGKILL"); } catch {} });

test("reconnect: client rebuilds session, re-registers, sees gap messages", async () => {
  // ── act 1: alice and driver join. driver posts msg-1 to alice.
  const driver = await newClient("driver-label");
  await call(driver.client, "register", { handle: "driver", agent_type: "test" });
  let alice = await newClient("alice-label");
  const reg1 = await call(alice.client, "register", { handle: "alice", agent_type: "claude-code" });
  ok(reg1?.cursor, "first register returned cursor");

  await call(driver.client, "say", { handle: "driver", message: "@alice msg-1 (pre-gap)" });
  // alice polls, sees msg-1, advances cursor.
  let r = await call(alice.client, "poll", { handle: "alice", since: reg1.cursor, timeout_ms: 1500 });
  eq(r.messages.length, 1, "alice receives msg-1");
  eq(r.messages[0].body, "@alice msg-1 (pre-gap)");
  let aliceCursor = r.cursor;

  // ── act 2: alice's transport "dies" mid-life. We tear down the client
  // entirely — this is the harshest simulation of the post-sleep state the
  // SDK might hand us (session-id orphaned on the server).
  await alice.client.close();

  // ── act 3: driver posts two more mentions WHILE alice is "asleep".
  await call(driver.client, "say", { handle: "driver", message: "@alice msg-2 (during-gap)" });
  await call(driver.client, "say", { handle: "driver", message: "@alice msg-3 (during-gap)" });

  // ── act 4: alice "wakes" — builds a new transport, re-registers with the
  // SAME handle, and resumes from her last cursor. This is exactly what the
  // Skill's reconnect block tells the agent to do.
  alice = await newClient("alice-label");
  const reg2 = await call(alice.client, "register", { handle: "alice", agent_type: "claude-code" });
  ok(reg2?.cursor, "re-register returned cursor");
  ok(!reg2?.error, `re-register did not error: ${JSON.stringify(reg2)}`);

  // ── invariant 1: the messages posted during the gap are still queued.
  // alice resumes from her last-known cursor, NOT from the fresh register
  // cursor (that one is a "now" snapshot and would skip the gap messages).
  r = await call(alice.client, "poll", { handle: "alice", since: aliceCursor, timeout_ms: 1500 });
  const bodies = r.messages.map((m) => m.body);
  eq(bodies, ["@alice msg-2 (during-gap)", "@alice msg-3 (during-gap)"],
     "alice picks up exactly the gap messages, in order");

  // ── invariant 2: a follow-up message posted post-reconnect arrives normally.
  await call(driver.client, "say", { handle: "driver", message: "@alice msg-4 (post-gap)" });
  r = await call(alice.client, "poll", { handle: "alice", since: r.cursor, timeout_ms: 1500 });
  eq(r.messages.length, 1, "alice receives post-gap msg");
  eq(r.messages[0].body, "@alice msg-4 (post-gap)");

  // ── invariant 3: alice's identity survived — `who` shows her once, with
  // the original handle, not duplicated.
  const who = await call(driver.client, "who", {});
  const aliceRows = who.participants.filter((p) => p.handle === "alice");
  eq(aliceRows.length, 1, "alice appears exactly once after reconnect");

  await alice.client.close();
  await driver.client.close();
});

test("reconnect: handle survives a full daemon restart (DB persists)", async () => {
  // Stronger guarantee: even if the DAEMON dies and restarts (the SQLite DB
  // is on disk so this is the realistic crash-recovery path), an agent that
  // re-registers with the same handle is welcomed back without collision.
  const c1 = await newClient("alice-label");
  const reg1 = await call(c1.client, "register", { handle: "alice2", agent_type: "claude-code" });
  ok(reg1?.cursor, "registered before restart");
  await c1.client.close();

  // Restart daemon. Our SIGTERM handler unlinks pid/port files so the second
  // boot doesn't refuse. Using SIGKILL would skip the cleanup; this test
  // path matches `murmur stop && murmur start`.
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.once("exit", r));

  const daemon2 = spawn(process.execPath, [join(ROOT, "src/daemon/murmurd.mjs"), `--port=${PORT}`], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let daemon2Out = "";
  daemon2.stdout.on("data", (b) => { daemon2Out += b.toString(); });
  daemon2.stderr.on("data", (b) => { daemon2Out += b.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !existsSync(join(TMP, "murmurd.port"))) {
    if (daemon2.exitCode !== null) throw new Error(`daemon2 died: ${daemon2Out}`);
    await delay(50);
  }

  const c2 = await newClient("alice-label");
  const reg2 = await call(c2.client, "register", { handle: "alice2", agent_type: "claude-code" });
  ok(!reg2?.error, `re-register after restart did not error: ${JSON.stringify(reg2)}`);
  ok(reg2?.cursor, "re-register after restart returned cursor");

  await c2.client.close();
  try { daemon2.kill("SIGTERM"); } catch {}
  await delay(200);
});

await run();

try { daemon.kill("SIGTERM"); } catch {}
await delay(200);
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
