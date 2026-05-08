// Long-poll soak: two simulated agents long-poll a real daemon for 60s while
// a third "driver" pumps mentions into the room. Asserts every message is
// delivered to its intended recipient with no losses, no duplicates, and no
// gaps where the agent went silent. This is the closest thing to the live
// product test we can run automatically — it covers the failure mode that
// motivated v1: "audit log shows things flowed but the user thought it died".
//
// Knob: SOAK_DURATION_S env var (default 60). Set higher locally if you want
// stronger confidence; CI keeps it at 60.

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, run, eq, ok } from "./_assert.mjs";

const PORT = 19997;
const TMP = mkdtempSync(join(tmpdir(), "murmur-soak-"));
const env = { ...process.env, MURMUR_HOME: TMP, MURMUR_PORT: String(PORT) };
const ROOT = new URL("..", import.meta.url).pathname;
const DURATION_S = Number(process.env.SOAK_DURATION_S ?? 60);

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
  const client = new Client({ name: `soak-${label}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

await waitForReady();
process.on("exit", () => { try { daemon.kill("SIGKILL"); } catch {} });

// ── soak ──────────────────────────────────────────────────────────────────
//
// alice and bob each long-poll in their own loop, narrating receives into a
// per-handle buffer. driver posts ~1 msg/sec, alternating @alice / @bob.

test(`soak: 2 long-pollers, ~${DURATION_S}s, every mention delivered`, async () => {
  const alice = await newClient("alice-label");
  const bob = await newClient("bob-label");
  const driver = await newClient("driver-label");

  await call(alice, "register", { handle: "alice", agent_type: "claude-code" });
  await call(bob, "register", { handle: "bob", agent_type: "codex-cli" });
  await call(driver, "register", { handle: "driver", agent_type: "test-driver" });

  const startCursor = (await call(alice, "history", { limit: 1 })).messages[0]?.id ?? "msg_0";
  const stopAt = Date.now() + DURATION_S * 1000;

  // Each receiver tracks: messages it saw addressed to it, and timestamps of
  // its own poll calls so we can detect long silence gaps.
  const state = (handle) => ({
    handle, received: [], pollAt: [],
    cursor: startCursor, errors: [], stopped: false,
  });
  const aState = state("alice");
  const bState = state("bob");

  async function loop(client, s) {
    while (!s.stopped && Date.now() < stopAt) {
      s.pollAt.push(Date.now());
      try {
        const r = await call(client, "poll", { handle: s.handle, since: s.cursor, timeout_ms: 5000 });
        s.cursor = r.cursor;
        for (const m of r.messages) {
          if (m.sender === s.handle) continue;
          if (m.mentions?.includes(s.handle) || m.mentions?.includes("all")) {
            s.received.push(m);
          }
        }
      } catch (err) {
        s.errors.push(String(err));
        await delay(200);
      }
    }
  }

  // Driver: fire one mention every ~600ms, alternating recipients.
  const sent = { alice: [], bob: [] };
  async function driverLoop() {
    let i = 0;
    while (Date.now() < stopAt) {
      const target = i % 2 === 0 ? "alice" : "bob";
      const body = `@${target} soak-${i}`;
      const r = await call(driver, "say", { handle: "driver", message: body });
      sent[target].push({ id: r.message_id, body, i });
      i++;
      await delay(600);
    }
  }

  const aLoop = loop(alice, aState);
  const bLoop = loop(bob, bState);
  const dLoop = driverLoop();
  await Promise.all([aLoop, bLoop, dLoop]);
  // Give a final long-poll cycle to drain the last in-flight message.
  await delay(500);
  aState.stopped = bState.stopped = true;
  await Promise.all([
    call(alice, "poll", { handle: "alice", since: aState.cursor, timeout_ms: 1000 }).then((r) => {
      for (const m of r.messages) {
        if (m.sender === "alice") continue;
        if (m.mentions?.includes("alice")) aState.received.push(m);
      }
    }),
    call(bob, "poll", { handle: "bob", since: bState.cursor, timeout_ms: 1000 }).then((r) => {
      for (const m of r.messages) {
        if (m.sender === "bob") continue;
        if (m.mentions?.includes("bob")) bState.received.push(m);
      }
    }),
  ]);

  // ── invariants ───────────────────────────────────────────────────────────

  // 1. No transport errors during the whole soak.
  eq(aState.errors.length, 0, `alice errors: ${aState.errors.join("|")}`);
  eq(bState.errors.length, 0, `bob errors: ${bState.errors.join("|")}`);

  // 2. Every sent mention to a recipient was received exactly once.
  const aReceivedBodies = aState.received.map((m) => m.body).sort();
  const aSentBodies = sent.alice.map((s) => s.body).sort();
  eq(aReceivedBodies, aSentBodies, "alice received != sent");
  const bReceivedBodies = bState.received.map((m) => m.body).sort();
  const bSentBodies = sent.bob.map((s) => s.body).sort();
  eq(bReceivedBodies, bSentBodies, "bob received != sent");

  // 3. No duplicate deliveries (cursor advance correctness).
  eq(new Set(aState.received.map((m) => m.id)).size, aState.received.length, "alice dup");
  eq(new Set(bState.received.map((m) => m.id)).size, bState.received.length, "bob dup");

  // 4. No silent gaps: max interval between successive poll calls < 8s.
  //    (timeout is 5s; we allow a 3s budget for SDK turnaround.)
  for (const s of [aState, bState]) {
    let maxGap = 0;
    for (let i = 1; i < s.pollAt.length; i++) {
      maxGap = Math.max(maxGap, s.pollAt[i] - s.pollAt[i - 1]);
    }
    ok(maxGap < 8000, `${s.handle} max poll gap was ${maxGap}ms (expected <8000)`);
    // And the loop should have made meaningful progress.
    ok(s.pollAt.length >= 5, `${s.handle} only polled ${s.pollAt.length}× in ${DURATION_S}s`);
  }

  // 5. Driver actually sent enough — >=10 msgs/each side at 600ms cadence.
  ok(sent.alice.length >= Math.floor(DURATION_S * 1000 / 600 / 2 - 2),
     `driver sent only ${sent.alice.length} msgs to alice`);
  ok(sent.bob.length >= Math.floor(DURATION_S * 1000 / 600 / 2 - 2),
     `driver sent only ${sent.bob.length} msgs to bob`);

  await alice.close();
  await bob.close();
  await driver.close();
});

await run();

try { daemon.kill("SIGTERM"); } catch {}
await delay(200);
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
