#!/usr/bin/env node
// Insert a STOP TEST message directly into the shared DB so well-behaved
// agents exit gracefully (and we can distinguish "saw stop" from "died").
//
// Token-guarded: the harness writes <run_dir>/.harness_token at startup;
// callers must pass --token=<value> matching that file. This prevents
// other processes on the machine (other agent sessions, CLI accidents)
// from terminating a running regression by guessing the DB path.
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
let dbPath = null;
let token = null;
for (const a of args) {
  const m = a.match(/^--token=(.+)$/);
  if (m) token = m[1];
  else if (!dbPath) dbPath = a;
}
if (!dbPath) {
  console.error("usage: inject_stop.mjs <db-path> --token=<token>");
  process.exit(2);
}

// Trace caller so we can find any unexpected invocations.
const traceLog = join(dirname(dbPath), "inject_stop_trace.log");
let parentInfo = "?";
try {
  parentInfo = execSync(`ps -p ${process.ppid} -o command=`, { encoding: "utf8" }).trim();
} catch {}
// Verify token against the harness-written file BEFORE doing anything.
const tokenFile = join(dirname(dbPath), ".harness_token");
let tokenStatus = "ok";
let expectedToken = null;
if (!existsSync(tokenFile)) {
  tokenStatus = "no_token_file";
} else {
  expectedToken = readFileSync(tokenFile, "utf8").trim();
  if (token !== expectedToken) tokenStatus = token ? "token_mismatch" : "token_missing";
}

appendFileSync(
  traceLog,
  JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    parent_cmd: parentInfo,
    argv: process.argv,
    env_keys: Object.keys(process.env).filter((k) => k.startsWith("MURMUR")),
    cwd: process.cwd(),
    token_status: tokenStatus,
  }) + "\n",
);

if (tokenStatus !== "ok") {
  console.error(`inject_stop refused: ${tokenStatus}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const r = db
  .prepare(
    "INSERT INTO messages (sender, body, mentions, ts) VALUES ('controller','@all STOP TEST',?,?)",
  )
  .run(JSON.stringify(["all"]), new Date().toISOString());
console.log(`STOP TEST inserted as msg_${r.lastInsertRowid}`);
