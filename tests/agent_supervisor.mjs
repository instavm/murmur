// End-to-end test of `murmur agent` supervisor mode against an isolated
// daemon, using a fake worker command instead of a real agent CLI.
// Covers: mention → ack → invoke → reply (with @sender prefixing),
// NO_REPLY suppression, ack/wip status-line skipping, and `@<handle> stop`.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, run, eq, ok } from "./_assert.mjs";

const PORT = 19997;
const TMP = mkdtempSync(join(tmpdir(), "murmur-agent-"));
const WORKER_LOG = join(TMP, "worker_invocations.log");
const env = { ...process.env, MURMUR_HOME: TMP, MURMUR_PORT: String(PORT), WORKER_LOG };

const ROOT = new URL("..", import.meta.url).pathname;

// Fake worker: logs each invocation, replies based on prompt content.
const WORKER = join(TMP, "worker.mjs");
writeFileSync(WORKER, `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.WORKER_LOG, "invoked\\n");
const prompt = process.argv[2] ?? "";
// Only react to the new message, not to room context echoed in the prompt.
const newMsg = prompt.split(/New message from [^:]+:\\n/)[1]?.split("\\n\\nInstructions:")[0] ?? prompt;
if (newMsg.includes("NOREPLYCASE")) console.log("NO_REPLY");
else console.log("done: fake work complete");
`);

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
  throw new Error(`daemon did not start: ${daemonOut}`);
}
await waitForReady();

// Supervisor under test, with the fake worker as the headless command.
const supervisor = spawn(process.execPath, [
  join(ROOT, "bin", "murmur"), "agent", "worker", `--cmd=${process.execPath} ${WORKER}`,
], { env, stdio: ["ignore", "pipe", "pipe"] });
let supOut = "";
supervisor.stdout.on("data", (b) => { supOut += b.toString(); });
supervisor.stderr.on("data", (b) => { supOut += b.toString(); });

async function newClient(label) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp/${label}`));
  const client = new Client({ name: `test-${label}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

const human = await newClient("human");
await call(human, "register", { handle: "human", agent_type: "human-cli" });

// Wait until the supervisor is registered and polling.
{
  const deadline = Date.now() + 10000;
  let joined = false;
  while (Date.now() < deadline && !joined) {
    joined = supOut.includes("joined murmur as @worker");
    if (!joined) await delay(100);
  }
  if (!joined) throw new Error(`supervisor did not join: ${supOut}`);
}

async function waitForMessage(pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await call(human, "history", { limit: 30 });
    const hit = (h?.messages ?? []).find(pred);
    if (hit) return hit;
    await delay(200);
  }
  return null;
}
const invocations = () =>
  existsSync(WORKER_LOG) ? readFileSync(WORKER_LOG, "utf8").split("\n").filter(Boolean).length : 0;

const teardown = async () => {
  try { supervisor.kill("SIGKILL"); } catch {}
  try { daemon.kill("SIGTERM"); } catch {}
  await delay(200);
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
};
process.on("exit", () => {
  try { supervisor.kill("SIGKILL"); } catch {}
  try { daemon.kill("SIGKILL"); } catch {}
});

// ── tests ─────────────────────────────────────────────────────────────────

test("mention → ack posted, worker invoked, reply posted with @sender prefix", async () => {
  await call(human, "say", { handle: "human", message: "@worker please do the thing" });
  const ack = await waitForMessage((m) => m.sender === "worker" && m.body.startsWith("@human ack:"));
  ok(ack, `expected ack from worker; supervisor output:\n${supOut}`);
  const done = await waitForMessage((m) => m.sender === "worker" && m.body.includes("fake work complete"));
  ok(done, `expected done reply; supervisor output:\n${supOut}`);
  // Worker's raw output had no mention — supervisor must prefix @human.
  ok(done.body.startsWith("@human "), `reply must be prefixed with @human, got: ${done.body}`);
  eq(invocations(), 1);
});

test("NO_REPLY output is not posted to the room", async () => {
  const before = (await call(human, "history", { limit: 1 })).messages[0]?.id;
  await call(human, "say", { handle: "human", message: "@worker NOREPLYCASE thanks!" });
  const ack = await waitForMessage(
    (m) => m.sender === "worker" && m.body.startsWith("@human ack:") && m.id > before,
  );
  ok(ack, "still acks receipt");
  await delay(1500);
  const h = await call(human, "history", { limit: 10 });
  const extra = h.messages.filter(
    (m) => m.sender === "worker" && m.id > ack.id,
  );
  eq(extra.length, 0, "no reply posted after ack for NO_REPLY");
  eq(invocations(), 2);
});

test("ack:/wip: status lines do not trigger an invocation", async () => {
  const n = invocations();
  await call(human, "say", { handle: "human", message: "@worker ack: starting something myself" });
  await call(human, "say", { handle: "human", message: "@worker wip: still going" });
  await delay(1500);
  eq(invocations(), n, "status lines must not invoke the worker");
});

test("unaddressed chatter is ignored", async () => {
  const n = invocations();
  await call(human, "say", { handle: "human", message: "just talking to @someone-else here" });
  await delay(1000);
  eq(invocations(), n);
});

test("a task that merely contains 'stop' is not a shutdown", async () => {
  const n = invocations();
  const sent = await call(human, "say", { handle: "human", message: "@worker stop using tabs and switch to spaces" });
  const sentNum = parseInt(String(sent.message_id).replace("msg_", ""), 10);
  const reply = await waitForMessage(
    (m) =>
      m.sender === "worker" &&
      m.body.includes("fake work complete") &&
      parseInt(String(m.id).replace("msg_", ""), 10) > sentNum,
  );
  ok(reply, "handled as a normal task");
  eq(supervisor.exitCode, null, "supervisor still running");
  ok(invocations() > n, "worker was invoked");
});

test("@worker stop makes the supervisor leave and exit", async () => {
  await call(human, "say", { handle: "human", message: "@worker stop" });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && supervisor.exitCode === null) await delay(100);
  eq(supervisor.exitCode, 0, `supervisor should exit 0; output:\n${supOut}`);
  const bye = await waitForMessage((m) => m.sender === "worker" && m.body.includes("leaving"), 2000);
  ok(bye, "posts a leaving message");
});

await run();
await human.close();
await teardown();
