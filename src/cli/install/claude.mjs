import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderSkill, upsertMarkedSection, removeMarkedSection } from "../../lib/markers.mjs";
import { daemonUrl } from "../../lib/mcp_client.mjs";

const HANDLE = "claude";
const AGENT_TYPE = "claude-code";
const CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");

function runClaude(args) {
  return execFileSync("claude", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

export async function install({ handle = HANDLE, pollTimeoutMs } = {}) {
  const url = daemonUrl(handle);
  const results = [];
  try {
    try { runClaude(["mcp", "remove", "murmur", "-s", "user"]); } catch {}
    runClaude(["mcp", "add", "--transport", "http", "-s", "user", "murmur", url]);
    results.push({ kind: "mcp", action: "registered", detail: `claude mcp add murmur (user scope) → ${url}` });
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().split("\n")[0];
    throw new Error(`claude mcp add failed: ${msg}`);
  }
  const skill = renderSkill({ handle, agent_type: AGENT_TYPE, poll_timeout_ms: pollTimeoutMs });
  const section = `## Murmur multi-agent room\n\n${skill}`;
  const r = upsertMarkedSection(CLAUDE_MD, section);
  results.push({ kind: "skill", ...r });
  return results;
}

export async function uninstall() {
  const results = [];
  try {
    runClaude(["mcp", "remove", "murmur", "-s", "user"]);
    results.push({ kind: "mcp", action: "removed" });
  } catch (e) {
    results.push({ kind: "mcp", action: "skip", detail: (e.stderr || e.message || "").toString().split("\n")[0] });
  }
  results.push({ kind: "skill", ...removeMarkedSection(CLAUDE_MD) });
  return results;
}
