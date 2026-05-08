#!/usr/bin/env node
// Read runs/<id>/audit.jsonl + db.sqlite. For each controller-injected
// mention message, find whether the addressed agent issued a `say` after
// the mention's timestamp, and how long after.
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const runDir = resolve(process.argv[2] || "runs");
const auditPath = join(runDir, "audit.jsonl");
const dbPath = join(runDir, "db.sqlite");
if (!existsSync(auditPath) || !existsSync(dbPath)) {
  console.error(`missing audit.jsonl or db.sqlite in ${runDir}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const msgs = db.prepare("SELECT id, sender, body, mentions, ts FROM messages ORDER BY id").all();

const events = readFileSync(auditPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const says = events
  .filter((e) => e.tool === "say")
  .map((e) => ({
    label: e.agent_label,
    handle: e.params?.handle,
    body: e.params?.message,
    ts: e.ts,
    t: Date.parse(e.ts),
  }))
  .sort((a, b) => a.t - b.t);

const handleToLabel = {
  claude_bot: "claude",
  codex_bot: "codex",
  gemini_bot: "gemini",
  cursor_bot: "cursor",
  copilot_bot: "copilot",
};

const targets = msgs
  .filter((m) => m.sender === "controller")
  .map((m) => {
    const mentions = JSON.parse(m.mentions || "[]");
    return { id: m.id, body: m.body, ts: m.ts, t: Date.parse(m.ts), mentions };
  })
  .filter((m) => !/STOP TEST/.test(m.body));

const rows = [];
for (const m of targets) {
  const expected = m.mentions.includes("all")
    ? Object.keys(handleToLabel)
    : m.mentions;
  for (const handle of expected) {
    const label = handleToLabel[handle];
    if (!label) continue;
    const tag = `msg_${m.id}`;
    const reply = says.find(
      (s) =>
        s.label === label &&
        s.t >= m.t &&
        !/goodbye/i.test(s.body || "") &&
        new RegExp(`\\b${tag}\\b`).test(s.body || ""),
    );
    rows.push({
      msg_id: m.id,
      to: handle,
      label,
      latency_ms: reply ? reply.t - m.t : null,
      reply_body: reply?.body ?? null,
      replied: !!reply,
    });
  }
}

const byLabel = {};
for (const r of rows) {
  (byLabel[r.label] ||= []).push(r);
}

const out = [];
out.push(`# Mention-response report`);
out.push("");
out.push(`Run dir: \`${runDir}\``);
out.push("");
out.push(`Mentions injected: ${targets.length}`);
out.push(`Expected (handle, mention) pairs: ${rows.length}`);
out.push("");
out.push(`| Agent | Mentions | Replies | Reply rate | Median latency (s) | Max latency (s) |`);
out.push(`|---|---:|---:|---:|---:|---:|`);
for (const label of Object.keys(byLabel).sort()) {
  const rs = byLabel[label];
  const replied = rs.filter((r) => r.replied);
  const lats = replied.map((r) => r.latency_ms).sort((a, b) => a - b);
  const med = lats.length ? lats[Math.floor((lats.length - 1) / 2)] : null;
  const max = lats.length ? lats[lats.length - 1] : null;
  out.push(
    `| ${label} | ${rs.length} | ${replied.length} | ${((replied.length / rs.length) * 100).toFixed(0)}% | ${med == null ? "—" : (med / 1000).toFixed(1)} | ${max == null ? "—" : (max / 1000).toFixed(1)} |`,
  );
}
out.push("");
out.push(`## Per-mention detail`);
out.push("");
out.push("| msg_id | to | latency (s) | reply |");
out.push("|---:|---|---:|---|");
for (const r of rows) {
  const lat = r.latency_ms == null ? "—" : (r.latency_ms / 1000).toFixed(1);
  const body = (r.reply_body || "").slice(0, 80).replace(/\|/g, "\\|");
  out.push(`| ${r.msg_id} | ${r.to} | ${lat} | ${body || "—"} |`);
}
out.push("");
const total = rows.length;
const replied = rows.filter((r) => r.replied).length;
out.push(`## Headline`);
out.push(`**${replied}/${total} expected replies received** (${((replied / total) * 100).toFixed(0)}%).`);

console.log(out.join("\n"));
