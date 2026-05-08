import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PID_FILE,
  PORT_FILE,
  LOG_FILE,
  DEFAULT_PORT,
  ensureMurmurHome,
} from "../lib/paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function start({ port = DEFAULT_PORT, foreground = false } = {}) {
  ensureMurmurHome();
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (pid && isAlive(pid)) {
      const p = existsSync(PORT_FILE) ? readFileSync(PORT_FILE, "utf8").trim() : "?";
      console.log(`murmurd already running (pid ${pid}, port ${p})`);
      return { pid, port: parseInt(p, 10) || port };
    }
  }
  const daemonPath = join(__dirname, "..", "daemon", "murmurd.mjs");
  if (foreground) {
    const child = spawn(process.execPath, [daemonPath, `--port=${port}`], {
      stdio: "inherit",
      env: { ...process.env, MURMUR_PORT: String(port) },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return { foreground: true };
  }
  const out = openSync(LOG_FILE, "a");
  const err = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [daemonPath, `--port=${port}`], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, MURMUR_PORT: String(port) },
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(PID_FILE) && existsSync(PORT_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
      const p = parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
      if (pid && isAlive(pid)) {
        console.log(`murmurd started (pid ${pid}, port ${p})`);
        console.log(`  log: ${LOG_FILE}`);
        return { pid, port: p };
      }
    }
  }
  console.error("murmurd failed to start within 5s. Check log:", LOG_FILE);
  process.exit(1);
}
