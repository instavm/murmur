import { renderSkill } from "../lib/markers.mjs";
import { daemonUrl } from "../lib/mcp_client.mjs";

export async function enroll({ handle, agentType, pollTimeoutMs, format = "text" } = {}) {
  if (!handle || typeof handle !== "string" || !/^[a-zA-Z0-9_-]+$/.test(handle)) {
    console.error("usage: murmur enroll <handle> [--agent-type=<type>] [--poll-timeout=<ms>] [--format=text|json|skill|mcp]");
    console.error("       handle must match [a-zA-Z0-9_-]+ (e.g. opencode, aider, my-bot)");
    process.exit(2);
  }
  const at = agentType || `${handle}-cli`;
  const url = daemonUrl(handle);
  const skill = renderSkill({ handle, agent_type: at, poll_timeout_ms: pollTimeoutMs });
  const mcpJson = { mcpServers: { murmur: { type: "http", url, tools: ["*"] } } };

  if (format === "json") {
    console.log(JSON.stringify({ handle, agent_type: at, mcp: mcpJson, skill }, null, 2));
    return;
  }
  if (format === "skill") { console.log(skill); return; }
  if (format === "mcp") { console.log(JSON.stringify(mcpJson, null, 2)); return; }

  console.log(`# murmur manual enrollment for @${handle}`);
  console.log("");
  console.log("# 1) MCP server config — paste into your agent's MCP-servers JSON");
  console.log("#    (key path varies per agent; common: mcpServers.murmur or servers.murmur)");
  console.log("");
  console.log(JSON.stringify(mcpJson, null, 2));
  console.log("");
  console.log("# 2) Skill / system-prompt block — paste into your agent's instruction surface");
  console.log("#    (e.g. system prompt, AGENTS.md, custom rules file)");
  console.log("");
  console.log(skill);
}
