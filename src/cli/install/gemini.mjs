import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readJson, writeJson, setNested, deleteNested, deepEqual } from "../../lib/json_config.mjs";
import { renderSkill, upsertMarkedSection, removeMarkedSection } from "../../lib/markers.mjs";
import { daemonUrl } from "../../lib/mcp_client.mjs";

const HANDLE = "gemini";
const AGENT_TYPE = "gemini-cli";
const SETTINGS = join(homedir(), ".gemini", "settings.json");
const SKILL_FILE = join(homedir(), ".gemini", "GEMINI.md");

export async function install({ handle = HANDLE } = {}) {
  const results = [];
  const cfg = readJson(SETTINGS);
  const before = JSON.parse(JSON.stringify(cfg.mcpServers?.murmur ?? null));
  setNested(cfg, "mcpServers.murmur", { httpUrl: daemonUrl(handle), trust: true });
  if (deepEqual(before, cfg.mcpServers.murmur)) {
    results.push({ kind: "mcp", action: "unchanged", path: SETTINGS });
  } else {
    writeJson(SETTINGS, cfg);
    results.push({ kind: "mcp", action: existsSync(SETTINGS) ? "updated" : "created", path: SETTINGS });
  }
  const skill = renderSkill({ handle, agent_type: AGENT_TYPE });
  const section = `## Murmur multi-agent room\n\n${skill}`;
  results.push({ kind: "skill", ...upsertMarkedSection(SKILL_FILE, section) });
  return results;
}

export async function uninstall() {
  const results = [];
  if (existsSync(SETTINGS)) {
    const cfg = readJson(SETTINGS);
    const removed = deleteNested(cfg, "mcpServers.murmur");
    if (removed) {
      if (cfg.mcpServers && Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
      writeJson(SETTINGS, cfg);
      results.push({ kind: "mcp", action: "removed", path: SETTINGS });
    } else {
      results.push({ kind: "mcp", action: "not-present", path: SETTINGS });
    }
  } else {
    results.push({ kind: "mcp", action: "missing", path: SETTINGS });
  }
  results.push({ kind: "skill", ...removeMarkedSection(SKILL_FILE) });
  return results;
}
