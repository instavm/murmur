import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderSkill, upsertMarkedSection, removeMarkedSection } from "../../lib/markers.mjs";
import { daemonUrl } from "../../lib/mcp_client.mjs";

const HANDLE = "codex";
const AGENT_TYPE = "codex-cli";
const CODEX_DIR = join(homedir(), ".codex");
const CONFIG_TOML = join(CODEX_DIR, "config.toml");
const AGENTS_MD = join(CODEX_DIR, "AGENTS.md");

const MCP_START = "# murmur:start";
const MCP_END = "# murmur:end";

function buildMcpBlock(handle) {
  return [
    MCP_START,
    `[mcp_servers.murmur]`,
    `url = "${daemonUrl(handle)}"`,
    `startup_timeout_sec = 20`,
    `tool_timeout_sec = 60`,
    `enabled = true`,
    MCP_END,
    "",
  ].join("\n");
}

function stripUnmarkedMurmurBlock(text) {
  const lines = text.split("\n");
  const out = [];
  let inBlock = false;
  let removed = false;
  for (const line of lines) {
    if (!inBlock && /^\s*\[mcp_servers\.murmur\]\s*$/.test(line)) {
      inBlock = true;
      removed = true;
      continue;
    }
    if (inBlock) {
      if (/^\s*\[/.test(line)) {
        inBlock = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), removed };
}

function upsertCodexMcp(handle) {
  mkdirSync(CODEX_DIR, { recursive: true });
  const block = buildMcpBlock(handle);
  let current = existsSync(CONFIG_TOML) ? readFileSync(CONFIG_TOML, "utf8") : "";
  let action;
  let detail = "";
  const markedRe = new RegExp(`${MCP_START}[\\s\\S]*?${MCP_END}\\n?`);
  if (markedRe.test(current)) {
    const replaced = current.replace(markedRe, block);
    if (replaced === current) {
      action = "unchanged";
    } else {
      writeFileSync(CONFIG_TOML, replaced);
      action = "updated";
    }
  } else {
    const stripped = stripUnmarkedMurmurBlock(current);
    if (stripped.removed) {
      detail = "(replaced pre-existing unmarked murmur block)";
    }
    const base = stripped.text;
    const sep = base.length === 0 ? "" : (base.endsWith("\n") ? "\n" : "\n\n");
    writeFileSync(CONFIG_TOML, base + sep + block);
    action = base.length === 0 ? "created" : "appended";
  }
  if (current === "" && !existsSync(CONFIG_TOML)) {
    writeFileSync(CONFIG_TOML, block);
  }
  return { kind: "mcp", action, path: CONFIG_TOML, detail };
}

export async function install({ handle = HANDLE, pollTimeoutMs } = {}) {
  const results = [];
  results.push(upsertCodexMcp(handle));
  const skill = renderSkill({ handle, agent_type: AGENT_TYPE, poll_timeout_ms: pollTimeoutMs });
  const section = `# Murmur multi-agent room\n\n${skill}`;
  results.push({ kind: "skill", ...upsertMarkedSection(AGENTS_MD, section) });
  return results;
}

export async function uninstall() {
  const results = [];
  if (existsSync(CONFIG_TOML)) {
    const current = readFileSync(CONFIG_TOML, "utf8");
    const re = new RegExp(`\\n*${MCP_START}[\\s\\S]*?${MCP_END}\\n?`);
    if (re.test(current)) {
      writeFileSync(CONFIG_TOML, current.replace(re, ""));
      results.push({ kind: "mcp", action: "removed", path: CONFIG_TOML });
    } else {
      results.push({ kind: "mcp", action: "not-present", path: CONFIG_TOML });
    }
  } else {
    results.push({ kind: "mcp", action: "missing", path: CONFIG_TOML });
  }
  results.push({ kind: "skill", ...removeMarkedSection(AGENTS_MD) });
  return results;
}
