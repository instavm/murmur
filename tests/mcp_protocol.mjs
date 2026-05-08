// MCP protocol tests against an isolated daemon spawned on a non-default port.
// Verifies tool semantics: register (idempotent + cross-label collision),
// say (mention parse, message_id), poll (timeout, cursor advance, mentions filter),
// who, history (limit + before).
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, run, eq, ok, includes } from "./_assert.mjs";

const PORT = 19999;
const TMP = mkdtempSync(join(tmpdir(), "murmur-mcp-"));
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
  const client = new Client({ name: `test-${label}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

await waitForReady();

const teardown = async () => {
  try { daemon.kill("SIGTERM"); } catch {}
  await delay(200);
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
};
process.on("exit", () => { try { daemon.kill("SIGKILL"); } catch {} });

// ── tests ─────────────────────────────────────────────────────────────────

test("register returns handle + cursor", async () => {
  const c = await newClient("alice-label");
  const r = await call(c, "register", { handle: "alice", agent_type: "claude-code" });
  eq(r.handle, "alice");
  ok(r.cursor.startsWith("msg_"), "cursor format msg_N");
  eq(r.room, "default");
  await c.close();
});

test("register is idempotent on same label/handle", async () => {
  const c = await newClient("alice-label");
  const r1 = await call(c, "register", { handle: "alice", agent_type: "claude-code" });
  const r2 = await call(c, "register", { handle: "alice", agent_type: "claude-code" });
  eq(r1.handle, r2.handle);
  ok(!r2.error, "no error on re-register");
  await c.close();
});

test("register collides across labels with suggestion", async () => {
  const cx = await newClient("other-label");
  const r = await call(cx, "register", { handle: "alice", agent_type: "x" });
  ok(r.error, "expected error");
  includes(r.suggestion, "alice");
  await cx.close();
});

test("say returns msg_id; mentions are parsed; history reflects", async () => {
  const a = await newClient("alice-label");
  await call(a, "register", { handle: "alice", agent_type: "claude-code" });
  const s = await call(a, "say", { handle: "alice", message: "hello @bob and @charlie" });
  ok(s.message_id.startsWith("msg_"));
  const h = await call(a, "history", { limit: 5 });
  const last = h.messages[0]; // newest first
  eq(last.sender, "alice");
  eq(last.body, "hello @bob and @charlie");
  eq(last.mentions, ["bob", "charlie"]);
  await a.close();
});

test("poll returns immediately when messages exist past cursor", async () => {
  const c = await newClient("alice-label");
  await call(c, "register", { handle: "alice", agent_type: "claude-code" });
  const r = await call(c, "poll", { handle: "alice", since: "msg_0", timeout_ms: 500 });
  ok(r.messages.length >= 1, "should see prior messages");
  ok(r.cursor !== "msg_0", "cursor advanced");
  await c.close();
});

test("poll respects timeout when no new messages", async () => {
  const c = await newClient("alice-label");
  await call(c, "register", { handle: "alice", agent_type: "claude-code" });
  const h = await call(c, "history", { limit: 1 });
  const cur = h.messages[0]?.id ?? "msg_0";
  const t0 = Date.now();
  const r = await call(c, "poll", { handle: "alice", since: cur, timeout_ms: 600 });
  const dur = Date.now() - t0;
  eq(r.messages.length, 0);
  eq(r.cursor, cur);
  ok(dur >= 500 && dur < 1500, `poll waited ~600ms (was ${dur}ms)`);
  await c.close();
});

test("poll wakes when another client posts mid-wait", async () => {
  const a = await newClient("alice-label");
  const b = await newClient("bob-label");
  await call(a, "register", { handle: "alice", agent_type: "claude-code" });
  await call(b, "register", { handle: "bob", agent_type: "codex-cli" });
  const h = await call(a, "history", { limit: 1 });
  const cur = h.messages[0]?.id ?? "msg_0";
  const pollPromise = call(a, "poll", { handle: "alice", since: cur, timeout_ms: 5000 });
  await delay(300);
  await call(b, "say", { handle: "bob", message: "@alice midwait" });
  const r = await pollPromise;
  eq(r.messages.length, 1);
  eq(r.messages[0].sender, "bob");
  eq(r.messages[0].mentions, ["alice"]);
  await a.close(); await b.close();
});

test("who lists registered participants", async () => {
  const c = await newClient("alice-label");
  const r = await call(c, "who", {});
  const handles = r.participants.map((p) => p.handle).sort();
  ok(handles.includes("alice"), "alice present");
  ok(handles.includes("bob"), "bob present");
  await c.close();
});

test("history limit + before pagination", async () => {
  const c = await newClient("alice-label");
  await call(c, "register", { handle: "alice", agent_type: "claude-code" });
  // post a few more so we have ≥4 messages
  for (let i = 0; i < 3; i++) await call(c, "say", { handle: "alice", message: `m${i}` });
  const page1 = await call(c, "history", { limit: 2 });
  eq(page1.messages.length, 2);
  ok(page1.has_more, "more available");
  const page2 = await call(c, "history", { limit: 2, before: page1.messages[1].id });
  ok(page2.messages.length >= 1);
  ok(page2.messages.every((m) => m.id < page1.messages[1].id), "page2 strictly older");
  await c.close();
});

await run();
await teardown();
