import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readJson, writeJson, setNested, deleteNested, deepEqual } from "../../lib/json_config.mjs";
import { renderSkill, upsertMarkedSection, removeMarkedSection } from "../../lib/markers.mjs";
import { daemonUrl } from "../../lib/mcp_client.mjs";

const HANDLE = "copilot";
const AGENT_TYPE = "copilot-cli";
const MCP_FILE = join(homedir(), ".copilot", "mcp-config.json");
const SKILL_FILE = join(homedir(), ".copilot", "AGENTS.md");

export async function install({ handle = HANDLE, pollTimeoutMs } = {}) {
  const results = [];
  const cfg = readJson(MCP_FILE);
  const before = JSON.parse(JSON.stringify(cfg.mcpServers?.murmur ?? null));
  setNested(cfg, "mcpServers.murmur", { type: "http", url: daemonUrl(handle), tools: ["*"] });
  if (deepEqual(before, cfg.mcpServers.murmur)) {
    results.push({ kind: "mcp", action: "unchanged", path: MCP_FILE });
  } else {
    writeJson(MCP_FILE, cfg);
    results.push({ kind: "mcp", action: existsSync(MCP_FILE) ? "updated" : "created", path: MCP_FILE });
  }
  const skill = renderSkill({ handle, agent_type: AGENT_TYPE, poll_timeout_ms: pollTimeoutMs });
  const section = `# Murmur multi-agent room\n\n${skill}\n\n_Note: copilot CLI loads AGENTS.md from CWD upward; if launching copilot from a directory tree without an AGENTS.md, copy this file there or symlink it._`;
  results.push({ kind: "skill", ...upsertMarkedSection(SKILL_FILE, section) });
  return results;
}

export async function uninstall() {
  const results = [];
  if (existsSync(MCP_FILE)) {
    const cfg = readJson(MCP_FILE);
    const removed = deleteNested(cfg, "mcpServers.murmur");
    if (removed) {
      if (cfg.mcpServers && Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
      writeJson(MCP_FILE, cfg);
      results.push({ kind: "mcp", action: "removed", path: MCP_FILE });
    } else {
      results.push({ kind: "mcp", action: "not-present", path: MCP_FILE });
    }
  } else {
    results.push({ kind: "mcp", action: "missing", path: MCP_FILE });
  }
  results.push({ kind: "skill", ...removeMarkedSection(SKILL_FILE) });
  return results;
}
