#!/usr/bin/env node
// Sleep-recovery probe v2.
//
// Question: when macOS sleeps mid-long-poll, which (if any) client recovery
// strategy actually gets back into the room without a full process restart?
//
// Setup: spawn a fresh `murmurd` on a non-conflicting port + tmp HOME so we
// don't interfere with anything else. Three synthetic SDK clients each
// long-poll with a different recovery policy:
//
//   A  naive       — on poll error: wait 2s, call poll() again (same client)
//   B  reregister  — on poll error: call register() then poll() (same client)
//   C  reconnect   — on poll error: tear down transport, create a new client,
//                    register, then poll
//
// A driver client posts heartbeats and a numbered WAKE-MARKER after each
// detected sleep/wake cycle. Sleep detection re-arms — every wall-clock
// jump > SLEEP_GAP_S triggers a fresh marker.
//
// Stop signal: create the file at $STOP_FILE (default /tmp/sleep_recovery_stop)
// and the probe drains and prints a summary. There's no auto-stop tied to
// wake events, so a multi-cycle sleep doesn't truncate the run.
//
// Usage:
//   node scripts/sleep_recovery.mjs &
//   # sleep your Mac, wake it, repeat as desired
//   touch /tmp/sleep_recovery_stop      # ends the probe cleanly

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.PROBE_PORT ?? 19996);
const HEARTBEAT_S = 15;
const POLL_TIMEOUT_MS = 25000;
const SLEEP_GAP_S = 30;
const STOP_FILE = process.env.STOP_FILE ?? "/tmp/sleep_recovery_stop";
const MAX_RUN_S = Number(process.env.MAX_RUN_S ?? 1800);  // 30 min hard cap

const TMP = mkdtempSync(join(tmpdir(), "murmur-sleep-"));
const env = { ...process.env, MURMUR_HOME: TMP, MURMUR_PORT: String(PORT) };
const ROOT = new URL("..", import.meta.url).pathname;

if (existsSync(STOP_FILE)) {
  // Stale stop file from a prior run — remove it so we don't exit immediately.
  try { rmSync(STOP_FILE); } catch {}
}

// ── murmurd ──────────────────────────────────────────────────────────────
const daemon = spawn(process.execPath, [join(ROOT, "src/daemon/murmurd.mjs"), `--port=${PORT}`], {
  env, stdio: ["ignore", "pipe", "pipe"],
});
let daemonOut = "";
daemon.stdout.on("data", (b) => { daemonOut += b.toString(); });
daemon.stderr.on("data", (b) => { daemonOut += b.toString(); });

async function waitDaemon(deadlineMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (existsSync(join(TMP, "murmurd.port"))) return;
    if (daemon.exitCode !== null) throw new Error(`daemon died: ${daemonOut}`);
    await delay(50);
  }
  throw new Error(`daemon did not start: ${daemonOut}`);
}
await waitDaemon();

const cleanupAll = () => {
  try { daemon.kill("SIGTERM"); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
};
process.on("exit", () => { try { daemon.kill("SIGKILL"); } catch {} });
process.on("SIGINT", () => { cleanupAll(); process.exit(130); });

// ── helpers ──────────────────────────────────────────────────────────────
async function newClient(label) {
  const url = new URL(`http://localhost:${PORT}/mcp/${label}`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: `probe-${label}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}
const T0 = Date.now();
const fmt = (ms) => `+${((ms - T0) / 1000).toFixed(1)}s`;
function log(tag, msg) {
  console.log(`[${fmt(Date.now())}] ${tag.padEnd(13)} ${msg}`);
}

// ── per-strategy poll loops ──────────────────────────────────────────────
function makeLoop(name, strategy) {
  const state = {
    name, strategy,
    polls: 0,
    errors: [],          // { at, msg }
    recoveries: [],      // { errAt, recoveredAt, dur_ms }
    markersSeen: [],     // { id, at, body }
    cursor: "msg_0", stop: false,
  };
  state.run = (async () => {
    let conn = await newClient(`${name}-label`);
    state.handle = name;
    await call(conn.client, "register", { handle: name, agent_type: "probe" });
    log(name, "registered, entering poll loop");

    while (!state.stop) {
      state.polls++;
      const lastErr = state.errors[state.errors.length - 1];
      try {
        const r = await call(conn.client, "poll", {
          handle: name, since: state.cursor, timeout_ms: POLL_TIMEOUT_MS,
        });
        state.cursor = r.cursor;
        for (const m of r.messages) {
          if (m.sender === name) continue;
          if (m.body.includes("WAKE-MARKER")) {
            state.markersSeen.push({ id: m.id, at: Date.now(), body: m.body });
            log(name, `received ${m.body} (${m.id})`);
          }
        }
        // If the previous iteration ended in error, mark this as a recovery.
        if (lastErr && (state.recoveries.length === 0 ||
            state.recoveries[state.recoveries.length - 1].errAt !== lastErr.at)) {
          const recoveredAt = Date.now();
          state.recoveries.push({
            errAt: lastErr.at,
            recoveredAt,
            dur_ms: recoveredAt - lastErr.at,
          });
          log(name, `recovered (poll succeeded ${recoveredAt - lastErr.at}ms after last error)`);
        }
      } catch (err) {
        const msg = String(err.message ?? err).slice(0, 120);
        state.errors.push({ at: Date.now(), msg });
        log(name, `poll error: ${msg}`);
        if (state.stop) break;
        if (strategy === "naive") {
          await delay(2000);
        } else if (strategy === "reregister") {
          try {
            await call(conn.client, "register", { handle: name, agent_type: "probe" });
            log(name, "re-registered on same transport");
          } catch (e2) {
            log(name, `re-register also failed: ${String(e2.message).slice(0, 100)}`);
            await delay(2000);
          }
        } else if (strategy === "reconnect") {
          try { await conn.client.close(); } catch {}
          try { conn = await newClient(`${name}-label`); } catch (e2) {
            log(name, `reconnect transport failed: ${String(e2.message).slice(0, 100)}`);
            await delay(2000);
            continue;
          }
          try {
            await call(conn.client, "register", { handle: name, agent_type: "probe" });
            log(name, "reconnected (new transport + register)");
          } catch (e2) {
            log(name, `re-register on new transport failed: ${String(e2.message).slice(0, 100)}`);
            await delay(2000);
          }
        }
      }
    }
    try { await conn.client.close(); } catch {}
  })();
  return state;
}

// ── driver: heartbeats + per-cycle wake-marker ────────────────────────────
const driverState = {
  stop: false,
  sleepEvents: [],     // { detectedAt, jumpedMs }
  markersPosted: [],   // { id, at, n }
  driver: await newClient("driver-label"),
};
await call(driverState.driver.client, "register", { handle: "driver", agent_type: "probe-driver" });

(async () => {
  let hb = 0;
  let markerN = 0;
  let lastHbAt = Date.now();
  let inSleep = false;
  while (!driverState.stop) {
    const before = Date.now();
    await delay(1000);
    const after = Date.now();
    if (after - before > SLEEP_GAP_S * 1000) {
      const jumpedMs = after - before;
      driverState.sleepEvents.push({ detectedAt: after, jumpedMs });
      log("driver", `SLEEP/WAKE DETECTED #${driverState.sleepEvents.length} — wall-clock jumped ${(jumpedMs/1000).toFixed(1)}s`);
      inSleep = true;
      // Brief delay so clients can settle their post-wake state before we
      // post the marker.
      await delay(2000);
      markerN++;
      const body = `@all WAKE-MARKER ${markerN}`;
      let posted = false;
      for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
        try {
          const r = await call(driverState.driver.client, "say", { handle: "driver", message: body });
          driverState.markersPosted.push({ id: r.message_id, at: Date.now(), n: markerN });
          log("driver", `posted ${body} as ${r.message_id} (attempt ${attempt})`);
          posted = true;
        } catch (err) {
          log("driver", `marker post attempt ${attempt} failed: ${String(err.message).slice(0, 100)}`);
          // Reconnect the driver and retry.
          try { await driverState.driver.client.close(); } catch {}
          try {
            driverState.driver = await newClient("driver-label");
            await call(driverState.driver.client, "register", { handle: "driver", agent_type: "probe-driver" });
          } catch (e2) {
            log("driver", `driver reconnect failed: ${String(e2.message).slice(0, 100)}`);
            await delay(1000);
          }
        }
      }
      if (!posted) log("driver", `gave up posting marker ${markerN} after 3 attempts`);
      lastHbAt = Date.now();   // suppress immediate heartbeat after marker
      inSleep = false;
    } else if (!inSleep && (after - lastHbAt) >= HEARTBEAT_S * 1000) {
      lastHbAt = after;
      hb++;
      try {
        await call(driverState.driver.client, "say", { handle: "driver", message: `@all heartbeat-${hb}` });
        log("driver", `heartbeat-${hb} posted`);
      } catch (err) {
        log("driver", `heartbeat-${hb} failed: ${String(err.message).slice(0, 100)}`);
      }
    }
  }
})();

// ── kick off the three strategies ────────────────────────────────────────
const strategies = [
  makeLoop("naive_a", "naive"),
  makeLoop("regis_b", "reregister"),
  makeLoop("recon_c", "reconnect"),
];

// Wait until everyone is registered + polling once.
await delay(2000);

console.log("");
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  READY — sleep your Mac now.");
console.log("    fastest: press Option-Cmd-Eject, or run `pmset sleepnow` in another terminal");
console.log("  Sleep / wake any number of times for as long as you like.");
console.log("  When you're done testing:");
console.log(`    touch ${STOP_FILE}`);
console.log("  The probe will then drain and print a summary. (Hard cap: " + (MAX_RUN_S/60) + " min.)");
console.log("══════════════════════════════════════════════════════════════════════");
console.log("");

// Wait until either the stop file shows up, or the hard cap fires.
const deadlineAt = Date.now() + MAX_RUN_S * 1000;
while (!existsSync(STOP_FILE) && Date.now() < deadlineAt) {
  await delay(1000);
}
if (existsSync(STOP_FILE)) {
  log("driver", "stop file detected — draining");
  try { rmSync(STOP_FILE); } catch {}
} else {
  log("driver", `hard cap reached at ${MAX_RUN_S}s — draining`);
}

driverState.stop = true;
for (const s of strategies) s.stop = true;
await Promise.all(strategies.map((s) => s.run.catch(() => {})));
// Give the driver loop one tick to exit.
await delay(1500);

// ── summary ──────────────────────────────────────────────────────────────
console.log("");
console.log("═════════════════════════════ SUMMARY ════════════════════════════════");
console.log(`sleep/wake events: ${driverState.sleepEvents.length}`);
for (const e of driverState.sleepEvents) {
  console.log(`   ${fmt(e.detectedAt)}  wall jumped ${(e.jumpedMs/1000).toFixed(1)}s`);
}
console.log(`markers posted:    ${driverState.markersPosted.length}`);
for (const m of driverState.markersPosted) {
  console.log(`   ${fmt(m.at)}  marker #${m.n} (${m.id})`);
}
console.log("");
for (const s of strategies) {
  const errs = s.errors.length;
  const recs = s.recoveries.length;
  const recDurs = s.recoveries.map((r) => `${r.dur_ms}ms`).join(",") || "—";
  const markerCount = s.markersSeen.length;
  const expected = driverState.markersPosted.length;
  console.log(`  ${s.name.padEnd(8)} polls=${String(s.polls).padStart(4)}  errors=${String(errs).padStart(2)}  recoveries=${String(recs).padStart(2)} (${recDurs})  markers_seen=${markerCount}/${expected}`);
  if (errs > 0) {
    const samples = [...new Set(s.errors.map((e) => e.msg))].slice(0, 3);
    for (const m of samples) console.log(`            err: ${m}`);
  }
}
console.log("══════════════════════════════════════════════════════════════════════");

cleanupAll();
process.exit(0);
