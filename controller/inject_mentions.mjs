#!/usr/bin/env node
// Inject a sequence of @-mention messages on a schedule. Each agent gets
// a personal ping plus a final @all ping. Use this to measure whether
// agents that are polling actually respond when addressed.
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
const handlesArg = process.argv[3] || "claude_bot,codex_bot,gemini_bot,cursor_bot,copilot_bot";
const intervalSec = Number(process.argv[4] || 45);
if (!dbPath) {
  console.error("usage: inject_mentions.mjs <db-path> [handles] [interval-sec]");
  process.exit(2);
}
const db = new DatabaseSync(dbPath);
const handles = handlesArg.split(",").map((s) => s.trim()).filter(Boolean);

const insert = (body, mentions) => {
  const r = db
    .prepare(
      "INSERT INTO messages (sender, body, mentions, ts) VALUES ('controller',?,?,?)",
    )
    .run(body, JSON.stringify(mentions), new Date().toISOString());
  console.log(`${new Date().toISOString()} msg_${r.lastInsertRowid}: ${body}`);
  return r.lastInsertRowid;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  for (const h of handles) {
    insert(`@${h} please reply with the word ack`, [h]);
    await sleep(intervalSec * 1000);
  }
  insert(`@all please reply with the word ack`, ["all"]);
};

await run();
