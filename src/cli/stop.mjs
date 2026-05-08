import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { PID_FILE, PORT_FILE } from "../lib/paths.mjs";

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function stop() {
  if (!existsSync(PID_FILE)) {
    console.log("murmurd is not running.");
    return;
  }
  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  if (!pid || !isAlive(pid)) {
    console.log("stale pid file; removing.");
    try { unlinkSync(PID_FILE); } catch {}
    try { unlinkSync(PORT_FILE); } catch {}
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isAlive(pid)) {
      console.log(`murmurd stopped (pid ${pid}).`);
      return;
    }
  }
  console.error(`murmurd (pid ${pid}) did not exit; sending SIGKILL.`);
  try { process.kill(pid, "SIGKILL"); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  try { unlinkSync(PORT_FILE); } catch {}
}
