import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_TMPL_PATH = join(__dirname, "..", "skill", "skill.md.tmpl");

export const MARKER_START = "<!-- murmur:start -->";
export const MARKER_END = "<!-- murmur:end -->";

export function renderSkill({ handle, agent_type }) {
  const tmpl = readFileSync(SKILL_TMPL_PATH, "utf8");
  return tmpl
    .replaceAll("<HANDLE>", handle)
    .replaceAll("<AGENT>", agent_type);
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
