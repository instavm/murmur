import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  MURMUR_HOME,
  DB_PATH,
  AUDIT_PATH,
  PID_FILE,
  PORT_FILE,
} from "../lib/paths.mjs";

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function status() {
  console.log(`home: ${MURMUR_HOME}`);
  let pid = null;
  let alive = false;
  if (existsSync(PID_FILE)) {
    pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    alive = pid && isAlive(pid);
  }
  const port = existsSync(PORT_FILE) ? readFileSync(PORT_FILE, "utf8").trim() : null;
  if (alive) {
    console.log(`daemon: up (pid ${pid}, port ${port})`);
  } else {
    console.log(`daemon: down${pid ? ` (stale pid file: ${pid})` : ""}`);
  }
  if (existsSync(DB_PATH)) {
    try {
      const db = new DatabaseSync(DB_PATH);
      const m = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
      const p = db.prepare("SELECT handle, agent_type, last_seen FROM participants ORDER BY last_seen DESC").all();
      console.log(`messages: ${m.n}`);
      console.log(`participants: ${p.length}`);
      for (const row of p) {
        console.log(`  @${row.handle}  (${row.agent_type})  last_seen=${row.last_seen}`);
      }
      db.close();
    } catch (e) {
      console.log(`db: error reading — ${e.message}`);
    }
  } else {
    console.log("db: (none yet)");
  }
  if (existsSync(AUDIT_PATH)) {
    const s = statSync(AUDIT_PATH);
    console.log(`audit: ${fmtBytes(s.size)}  (${AUDIT_PATH})`);
  }
}
