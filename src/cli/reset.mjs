import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DB_PATH, PID_FILE } from "../lib/paths.mjs";

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function reset({ yes = false } = {}) {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (pid && isAlive(pid)) {
      console.error("murmurd is running. Stop it first with `murmur stop`.");
      process.exit(1);
    }
  }
  if (!existsSync(DB_PATH)) {
    console.log("db not found; nothing to reset.");
    return;
  }
  if (!yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question(`Drop all messages and participants in ${DB_PATH}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      console.log("aborted.");
      return;
    }
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec("DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS participants;");
  db.close();
  console.log(`reset: cleared ${DB_PATH}.`);
}
