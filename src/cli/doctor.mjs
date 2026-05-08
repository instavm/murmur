import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MURMUR_HOME,
  PID_FILE,
  PORT_FILE,
  DB_PATH,
} from "../lib/paths.mjs";
import { detectAll } from "./detect.mjs";
import { connect, callTool } from "../lib/mcp_client.mjs";
import { liveness, fmtAge, STATUS_TAG, FRESH_MAX_S, STALE_MAX_S } from "../lib/liveness.mjs";

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const SKILL_PATHS = {
  claude:  () => join(homedir(), ".claude", "CLAUDE.md"),
  codex:   () => join(homedir(), ".codex", "AGENTS.md"),
  gemini:  () => join(homedir(), ".gemini", "GEMINI.md"),
  cursor:  () => join(homedir(), ".cursor", "rules", "murmur.md"),
  copilot: () => join(homedir(), ".copilot", "AGENTS.md"),
};

function check(label, ok, detail = "") {
  const tag = ok ? "✓" : "✗";
  console.log(`${tag} ${label}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

export async function doctor() {
  let allOk = true;
  console.log(`murmur home: ${MURMUR_HOME}`);

  const homeOk = existsSync(MURMUR_HOME);
  allOk &= check("home dir exists", homeOk, MURMUR_HOME);

  let pid = null, port = null, daemonUp = false;
  if (existsSync(PID_FILE)) {
    pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    daemonUp = pid && isAlive(pid);
  }
  if (existsSync(PORT_FILE)) port = readFileSync(PORT_FILE, "utf8").trim();
  allOk &= check("daemon running", !!daemonUp, daemonUp ? `pid ${pid}, port ${port}` : "run `murmur start`");

  let participants = [];
  if (daemonUp) {
    try {
      const conn = await connect("_doctor");
      const who = await callTool(conn.client, "who", {});
      participants = who?.participants ?? [];
      check("daemon reachable via HTTP MCP", true, `${participants.length} participant(s)`);
      await conn.close();
    } catch (e) {
      allOk = false;
      check("daemon reachable via HTTP MCP", false, e.message);
    }
  }

  check("db file present", existsSync(DB_PATH), DB_PATH);

  console.log("");
  console.log("agent installs:");
  const agents = detectAll();
  for (const a of agents) {
    if (!a.detected) {
      console.log(`  ${a.name}: not on PATH`);
      continue;
    }
    const skillPath = SKILL_PATHS[a.name]?.();
    const skillOk = skillPath && existsSync(skillPath) && /murmur:start/.test(readFileSync(skillPath, "utf8"));
    const tag = skillOk ? "✓" : "✗";
    console.log(`  ${tag} ${a.name}: skill ${skillOk ? "present" : "MISSING"} at ${skillPath}`);
    if (!skillOk) allOk = false;
  }

  if (daemonUp) {
    console.log("");
    console.log(`room liveness  (fresh ≤${FRESH_MAX_S}s · stale ≤${STALE_MAX_S}s · dead >${STALE_MAX_S}s):`);
    if (participants.length === 0) {
      console.log("  (no participants registered)");
    } else {
      const rows = liveness(participants);
      let anyStalled = false;
      for (const r of rows) {
        if (r.status === "stale" || r.status === "dead") anyStalled = true;
        console.log(`  ${STATUS_TAG[r.status]} @${r.handle.padEnd(8)} ${r.status.padEnd(5)} (last poll ${fmtAge(r.ageS)} ago)`);
      }
      if (anyStalled) {
        console.log("  → stalled agents may need a poke: `murmur poke <handle>`");
      }
    }
  }

  console.log("");
  console.log(allOk ? "all checks passed." : "some checks failed — see ✗ lines above.");
  if (!allOk) process.exitCode = 1;
}
