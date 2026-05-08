#!/usr/bin/env node
// Read runs/<id>/audit.jsonl and produce a per-agent Markdown report.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const runDir = resolve(process.argv[2] || "runs");
const auditPath = join(runDir, "audit.jsonl");
if (!existsSync(auditPath)) {
  console.error(`audit.jsonl not found at ${auditPath}`);
  process.exit(1);
}

const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
const events = lines.map((l, i) => {
  try {
    return JSON.parse(l);
  } catch (e) {
    console.error(`bad line ${i + 1}: ${l.slice(0, 80)}`);
    return null;
  }
}).filter(Boolean);

const byLabel = {};
for (const e of events) {
  const k = e.agent_label || "_unknown";
  (byLabel[k] ||= []).push(e);
}

const summarize = (label, evs) => {
  evs.sort((a, b) => a.ts.localeCompare(b.ts));
  const polls = evs.filter((e) => e.tool === "poll");
  const says = evs.filter((e) => e.tool === "say");
  const regs = evs.filter((e) => e.tool === "register");
  const startup = evs.find((e) => e.tool === "_startup");

  const sawStop = says.some(
    (s) => /goodbye/i.test(s.params?.message || ""),
  );
  const stopCandidates = polls.filter(
    (p) => (p.result_summary?.messages || 0) > 0,
  );
  // Did the agent receive STOP TEST in any poll? Best signal: a poll that
  // returned ≥1 message AND the agent then issued at least one say after it.
  const lastPoll = polls[polls.length - 1];
  const firstReg = regs[0];
  const tStart = (firstReg || startup)?.ts;
  const tLastPoll = lastPoll?.ts;

  const lifetime_s =
    tStart && tLastPoll
      ? (Date.parse(tLastPoll) - Date.parse(tStart)) / 1000
      : null;

  // Inter-poll gaps (ms)
  const gaps = [];
  for (let i = 1; i < polls.length; i++) {
    gaps.push(Date.parse(polls[i].ts) - Date.parse(polls[i - 1].ts));
  }
  gaps.sort((a, b) => a - b);
  const pct = (p) => (gaps.length ? gaps[Math.floor((gaps.length - 1) * p)] : null);

  let exit_signal;
  if (sawStop) exit_signal = "stop_seen";
  else if (polls.length === 0) exit_signal = "never_polled";
  else if (regs.length === 0) exit_signal = "never_registered";
  else exit_signal = "silent_stop";

  return {
    label,
    n_register: regs.length,
    n_polls: polls.length,
    n_says: says.length,
    n_polls_with_msg: stopCandidates.length,
    first_event_ts: evs[0]?.ts,
    last_event_ts: evs[evs.length - 1]?.ts,
    register_ts: tStart,
    last_poll_ts: tLastPoll,
    lifetime_s,
    survived_15min: lifetime_s !== null && lifetime_s >= 900,
    survived_5min: lifetime_s !== null && lifetime_s >= 300,
    inter_poll_p50_ms: pct(0.5),
    inter_poll_p95_ms: pct(0.95),
    exit_signal,
  };
};

const labels = Object.keys(byLabel)
  .filter((l) => !["_unknown", "_init"].includes(l))
  .sort();
const rows = labels.map((l) => summarize(l, byLabel[l]));

const fmt = (v) => (v == null ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
const fmtBool = (v) => (v == null ? "—" : v ? "✓" : "✗");

const out = [];
out.push(`# Polling-loop survival report`);
out.push("");
out.push(`Run dir: \`${runDir}\``);
out.push("");
out.push(`Total events: ${events.length} across ${labels.length} agent label(s).`);
out.push("");
out.push(`| Agent | Lifetime (s) | ≥15 min | ≥5 min | Polls | Says | Polls w/ msg | p50 gap (ms) | p95 gap (ms) | Exit |`);
out.push(`|---|---:|:---:|:---:|---:|---:|---:|---:|---:|---|`);
for (const r of rows) {
  out.push(
    `| ${r.label} | ${fmt(r.lifetime_s)} | ${fmtBool(r.survived_15min)} | ${fmtBool(r.survived_5min)} | ${fmt(r.n_polls)} | ${fmt(r.n_says)} | ${fmt(r.n_polls_with_msg)} | ${fmt(r.inter_poll_p50_ms)} | ${fmt(r.inter_poll_p95_ms)} | ${r.exit_signal} |`,
  );
}
out.push("");
out.push("## Per-agent detail");
for (const r of rows) {
  out.push(`### ${r.label}`);
  out.push("```json");
  out.push(JSON.stringify(r, null, 2));
  out.push("```");
}
out.push("");
out.push("## Headline");
const survivors = rows.filter((r) => r.survived_15min).length;
const total = rows.length;
out.push(`**${survivors}/${total} agents survived ≥15 min** of polling against the stub server.`);
const five = rows.filter((r) => r.survived_5min).length;
out.push(`**${five}/${total} agents survived ≥5 min.**`);
out.push("");

console.log(out.join("\n"));
