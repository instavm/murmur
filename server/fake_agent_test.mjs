#!/usr/bin/env node
// Spawn stub.mjs as an MCP subprocess via the SDK client and exercise the
// 5 tools. Verifies protocol correctness without involving any LLM.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const RUN_DIR = resolve("runs/_verify");
rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(RUN_DIR, { recursive: true });

const env = {
  ...process.env,
  MURMUR_DB: `${RUN_DIR}/db.sqlite`,
  MURMUR_AUDIT: `${RUN_DIR}/audit.jsonl`,
};

async function makeClient(label) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve("server/stub.mjs"), `--label=${label}`],
    env,
  });
  const client = new Client({ name: `verifier-${label}`, version: "0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text;
  return text ? JSON.parse(text) : r;
}

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const ok = (msg) => console.log("OK:", msg);

const a = await makeClient("agentA");
const b = await makeClient("agentB");

// list tools
const tools = await a.client.listTools();
if (tools.tools.length !== 5) fail(`expected 5 tools, got ${tools.tools.length}`);
ok(`tool list: ${tools.tools.map((t) => t.name).join(", ")}`);

// register two participants
const regA = await call(a.client, "register", { handle: "alice", agent_type: "test" });
if (!regA.cursor) fail(`register A: ${JSON.stringify(regA)}`);
ok(`register alice -> cursor=${regA.cursor}`);

const regB = await call(b.client, "register", { handle: "bob", agent_type: "test" });
if (!regB.cursor) fail(`register B: ${JSON.stringify(regB)}`);
ok(`register bob -> cursor=${regB.cursor}`);

// duplicate handle should error
const dup = await call(a.client, "register", { handle: "bob", agent_type: "test" });
if (!dup.error) fail(`expected duplicate handle error, got ${JSON.stringify(dup)}`);
ok(`duplicate handle rejected: ${dup.error}`);

// alice says, bob polls
const sayP = call(a.client, "say", { handle: "alice", message: "@bob hello there" });
const pollR = await call(b.client, "poll", {
  handle: "bob",
  since: regB.cursor,
  timeout_ms: 5000,
});
await sayP;
if (pollR.messages.length !== 1) fail(`bob expected 1 msg, got ${pollR.messages.length}`);
if (!pollR.messages[0].mentions.includes("bob")) fail(`mention parse: ${JSON.stringify(pollR.messages[0])}`);
ok(`bob received: "${pollR.messages[0].body}" cursor=${pollR.cursor}`);

// long-poll timeout returns empty
const t0 = Date.now();
const empty = await call(b.client, "poll", {
  handle: "bob",
  since: pollR.cursor,
  timeout_ms: 1500,
});
const dt = Date.now() - t0;
if (empty.messages.length !== 0) fail(`expected empty, got ${empty.messages.length}`);
if (dt < 1000) fail(`expected ~1500ms wait, got ${dt}ms`);
ok(`long-poll empty after ${dt}ms`);

// who
const whoR = await call(a.client, "who", {});
if (whoR.participants.length !== 2) fail(`expected 2 participants, got ${whoR.participants.length}`);
ok(`who -> ${whoR.participants.map((p) => p.handle).join(", ")}`);

// history
const histR = await call(a.client, "history", { limit: 10 });
if (histR.messages.length !== 1) fail(`expected 1 in history, got ${histR.messages.length}`);
ok(`history -> ${histR.messages.length} msg`);

await a.transport.close();
await b.transport.close();

// Inspect audit log
const audit = readFileSync(env.MURMUR_AUDIT, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const byTool = audit.reduce((acc, e) => {
  acc[e.tool] = (acc[e.tool] || 0) + 1;
  return acc;
}, {});
ok(`audit entries by tool: ${JSON.stringify(byTool)}`);

console.log("\nALL VERIFIER CHECKS PASSED");
