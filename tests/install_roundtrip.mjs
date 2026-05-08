// Per-agent install/uninstall round-trip into a tmp HOME.
// Verifies config file shape, skill markers, idempotency, and that
// uninstall preserves user content. Skips the claude adapter (it shells
// out to the real `claude` binary).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run, eq, ok, includes } from "./_assert.mjs";

// Set HOME + MURMUR_PORT BEFORE importing adapters — they snapshot paths at module load.
const TMP = mkdtempSync(join(tmpdir(), "murmur-install-"));
process.env.HOME = TMP;
process.env.MURMUR_PORT = "9999";
delete process.env.MURMUR_HOME; // ensure no leak from outer shell
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

// Dynamic imports so HOME override applies.
const codex = await import("../src/cli/install/codex.mjs");
const gemini = await import("../src/cli/install/gemini.mjs");
const cursor = await import("../src/cli/install/cursor.mjs");
const copilot = await import("../src/cli/install/copilot.mjs");

const URL_BASE = "http://localhost:9999/mcp";

// ── codex (TOML) ──────────────────────────────────────────────────────────

test("codex install creates config.toml + AGENTS.md when absent", async () => {
  // Clean slate for codex
  rmSync(join(TMP, ".codex"), { recursive: true, force: true });
  const r = await codex.install();
  const toml = readFileSync(join(TMP, ".codex", "config.toml"), "utf8");
  includes(toml, "# murmur:start");
  includes(toml, "# murmur:end");
  includes(toml, "[mcp_servers.murmur]");
  includes(toml, `${URL_BASE}/codex`);
  const agents = readFileSync(join(TMP, ".codex", "AGENTS.md"), "utf8");
  includes(agents, "<!-- murmur:start -->");
  includes(agents, "Murmur multi-agent room");
});

test("codex install is idempotent (second call → unchanged)", async () => {
  const r2 = await codex.install();
  const mcp = r2.find(x => x.kind === "mcp");
  eq(mcp.action, "unchanged");
});

test("codex preserves a pre-existing [mcp_servers.playwright] block during round-trip", async () => {
  rmSync(join(TMP, ".codex"), { recursive: true, force: true });
  mkdirSync(join(TMP, ".codex"), { recursive: true });
  const userToml = `model = "gpt-5"
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]
`;
  writeFileSync(join(TMP, ".codex", "config.toml"), userToml);
  await codex.install();
  await codex.uninstall();
  const after = readFileSync(join(TMP, ".codex", "config.toml"), "utf8");
  includes(after, '[mcp_servers.playwright]');
  includes(after, 'command = "npx"');
  ok(!after.includes("[mcp_servers.murmur]"), "murmur block fully removed");
  ok(!after.includes("# murmur:start"), "murmur markers fully removed");
});

// ── gemini (JSON) ─────────────────────────────────────────────────────────

test("gemini install writes mcpServers.murmur with correct shape", async () => {
  rmSync(join(TMP, ".gemini"), { recursive: true, force: true });
  await gemini.install();
  const cfg = JSON.parse(readFileSync(join(TMP, ".gemini", "settings.json"), "utf8"));
  eq(cfg.mcpServers.murmur.httpUrl, `${URL_BASE}/gemini`);
  eq(cfg.mcpServers.murmur.trust, true);
  const skill = readFileSync(join(TMP, ".gemini", "GEMINI.md"), "utf8");
  includes(skill, "<!-- murmur:start -->");
});

test("gemini install is idempotent", async () => {
  const r = await gemini.install();
  eq(r.find(x => x.kind === "mcp").action, "unchanged");
});

test("gemini uninstall preserves other mcpServers entries", async () => {
  rmSync(join(TMP, ".gemini"), { recursive: true, force: true });
  mkdirSync(join(TMP, ".gemini"), { recursive: true });
  writeFileSync(join(TMP, ".gemini", "settings.json"),
    JSON.stringify({ theme: "dark", mcpServers: { other: { httpUrl: "http://x" } } }, null, 2));
  await gemini.install();
  await gemini.uninstall();
  const cfg = JSON.parse(readFileSync(join(TMP, ".gemini", "settings.json"), "utf8"));
  eq(cfg.theme, "dark");
  eq(cfg.mcpServers.other.httpUrl, "http://x");
  ok(!("murmur" in (cfg.mcpServers || {})), "murmur key removed");
});

test("gemini uninstall drops empty mcpServers entirely", async () => {
  rmSync(join(TMP, ".gemini"), { recursive: true, force: true });
  await gemini.install();
  await gemini.uninstall();
  const cfg = JSON.parse(readFileSync(join(TMP, ".gemini", "settings.json"), "utf8"));
  ok(!("mcpServers" in cfg), "empty mcpServers removed");
});

// ── cursor (JSON, different shape: url not httpUrl) ───────────────────────

test("cursor install writes mcpServers.murmur with url field", async () => {
  rmSync(join(TMP, ".cursor"), { recursive: true, force: true });
  await cursor.install();
  const cfg = JSON.parse(readFileSync(join(TMP, ".cursor", "mcp.json"), "utf8"));
  eq(cfg.mcpServers.murmur.url, `${URL_BASE}/cursor`);
  ok(!("httpUrl" in cfg.mcpServers.murmur), "cursor uses .url, not .httpUrl");
  const skill = readFileSync(join(TMP, ".cursor", "rules", "murmur.md"), "utf8");
  includes(skill, "<!-- murmur:start -->");
});

test("cursor uninstall round-trip clean", async () => {
  await cursor.uninstall();
  const cfgPath = join(TMP, ".cursor", "mcp.json");
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    ok(!("mcpServers" in cfg) || !("murmur" in cfg.mcpServers), "murmur gone");
  }
  const skillPath = join(TMP, ".cursor", "rules", "murmur.md");
  if (existsSync(skillPath)) {
    const sk = readFileSync(skillPath, "utf8");
    ok(!sk.includes("<!-- murmur:start -->"), "skill markers gone");
  }
});

// ── copilot (JSON, type/url/tools shape) ──────────────────────────────────

test("copilot install writes type=http, url, tools=[*]", async () => {
  rmSync(join(TMP, ".copilot"), { recursive: true, force: true });
  await copilot.install();
  const cfg = JSON.parse(readFileSync(join(TMP, ".copilot", "mcp-config.json"), "utf8"));
  eq(cfg.mcpServers.murmur.type, "http");
  eq(cfg.mcpServers.murmur.url, `${URL_BASE}/copilot`);
  eq(cfg.mcpServers.murmur.tools, ["*"]);
});

test("copilot uninstall preserves a pre-existing playwright stdio entry", async () => {
  rmSync(join(TMP, ".copilot"), { recursive: true, force: true });
  mkdirSync(join(TMP, ".copilot"), { recursive: true });
  writeFileSync(join(TMP, ".copilot", "mcp-config.json"),
    JSON.stringify({ mcpServers: { playwright: { type: "local", command: "npx", args: ["@playwright/mcp@latest"] } } }, null, 2));
  await copilot.install();
  await copilot.uninstall();
  const cfg = JSON.parse(readFileSync(join(TMP, ".copilot", "mcp-config.json"), "utf8"));
  eq(cfg.mcpServers.playwright.command, "npx");
  ok(!("murmur" in cfg.mcpServers), "murmur removed");
});

await run();
