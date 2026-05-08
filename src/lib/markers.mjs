import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_TMPL_PATH = join(__dirname, "..", "skill", "skill.md.tmpl");

export const DEFAULT_POLL_TIMEOUT_MS = 30000;
const MIN_POLL_TIMEOUT_MS = 1000;
const MAX_POLL_TIMEOUT_MS = 60000;

export function resolvePollTimeoutMs(explicit) {
  const raw = explicit ?? process.env.MURMUR_POLL_TIMEOUT_MS;
  const n = raw == null || raw === "" ? DEFAULT_POLL_TIMEOUT_MS : parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_POLL_TIMEOUT_MS;
  return Math.min(MAX_POLL_TIMEOUT_MS, Math.max(MIN_POLL_TIMEOUT_MS, n));
}

export const MARKER_START = "<!-- murmur:start -->";
export const MARKER_END = "<!-- murmur:end -->";

export function renderSkill({ handle, agent_type, poll_timeout_ms } = {}) {
  const tmpl = readFileSync(SKILL_TMPL_PATH, "utf8");
  const ms = resolvePollTimeoutMs(poll_timeout_ms);
  return tmpl
    .replaceAll("<HANDLE>", handle)
    .replaceAll("<AGENT>", agent_type)
    .replaceAll("<POLL_TIMEOUT_MS>", String(ms));
}

export function upsertMarkedSection(filePath, body) {
  mkdirSync(dirname(filePath), { recursive: true });
  const block = `${MARKER_START}\n${body.trimEnd()}\n${MARKER_END}\n`;
  if (!existsSync(filePath)) {
    writeFileSync(filePath, block);
    return { action: "created", path: filePath };
  }
  const current = readFileSync(filePath, "utf8");
  const re = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}\\n?`);
  if (re.test(current)) {
    const replaced = current.replace(re, block);
    if (replaced === current) return { action: "unchanged", path: filePath };
    writeFileSync(filePath, replaced);
    return { action: "updated", path: filePath };
  }
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(filePath, current + sep + block);
  return { action: "appended", path: filePath };
}

export function removeMarkedSection(filePath) {
  if (!existsSync(filePath)) return { action: "missing", path: filePath };
  const current = readFileSync(filePath, "utf8");
  const re = new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n?`);
  if (!re.test(current)) return { action: "not-present", path: filePath };
  writeFileSync(filePath, current.replace(re, ""));
  return { action: "removed", path: filePath };
}
