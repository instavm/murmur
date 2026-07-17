import readline from "node:readline";
import { connect, callTool } from "../lib/mcp_client.mjs";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const HANDLE_COLORS = [33, 32, 36, 35, 31, 34, 93, 92, 96, 95, 91, 94];

function colorFor(handle) {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return HANDLE_COLORS[h % HANDLE_COLORS.length];
}

function fmtTs(ts) {
  return ts.replace("T", " ").slice(11, 19);
}

function colorize(s, code) {
  return `\x1b[${code}m${s}${RESET}`;
}

function highlightMentions(body) {
  return body.replace(/@([a-zA-Z0-9_-]+)/g, (m, h) => {
    const c = colorFor(h);
    return `${BOLD}\x1b[${c}m${m}${RESET}`;
  });
}

function renderMessage(m, prompt) {
  const color = colorFor(m.sender);
  const line = `${DIM}${fmtTs(m.timestamp)}${RESET}  ${colorize(`@${m.sender}`.padEnd(10), color)}  ${highlightMentions(m.body)}`;
  process.stdout.write("\r\x1b[K");
  process.stdout.write(line + "\n");
  if (prompt) prompt();
}

// Cursor to resume live polling from after replaying `messages`: the highest
// message id seen. NOT history()'s `cursor` field — that is a pagination
// cursor pointing at the OLDEST message of the page; polling from it would
// re-deliver everything just replayed.
export function replayCursor(messages, initial = "msg_0") {
  let max = parseInt(String(initial).replace("msg_", ""), 10) || 0;
  for (const m of messages) {
    const n = parseInt(String(m.id).replace("msg_", ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `msg_${max}`;
}

export async function watch({ replay = 20, handle = "human" } = {}) {
  const conn = await connect(handle);
  const { client } = conn;
  let cursor = "msg_0";

  console.log(`${BOLD}murmur · room: default${RESET}`);
  console.log(`${DIM}Type a message and press Enter. Mention any agent with @handle. Ctrl-C to quit.${RESET}`);
  console.log(`${DIM}${"─".repeat(64)}${RESET}`);

  await callTool(client, "register", { handle, agent_type: "human-cli" });

  const past = await callTool(client, "history", { limit: replay });
  const msgs = (past?.messages ?? []).slice().reverse();
  for (const m of msgs) renderMessage(m, null);
  cursor = replayCursor(msgs, cursor);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}> ${RESET}`,
  });
  rl.prompt();
  const refreshPrompt = () => rl.prompt(true);

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    try {
      await callTool(client, "say", { handle, message: text });
    } catch (e) {
      process.stdout.write(`${DIM}(send failed: ${e.message})${RESET}\n`);
    }
    rl.prompt();
  });

  let stopped = false;
  rl.on("close", async () => {
    stopped = true;
    process.stdout.write("\n");
    try { await conn.close(); } catch {}
    process.exit(0);
  });

  while (!stopped) {
    try {
      const res = await callTool(client, "poll", {
        handle,
        since: cursor,
        timeout_ms: 25000,
      });
      const newMsgs = res?.messages ?? [];
      for (const m of newMsgs) {
        if (m.sender === handle) continue;
        renderMessage(m, refreshPrompt);
      }
      if (res?.cursor) cursor = res.cursor;
    } catch (e) {
      if (stopped) break;
      process.stdout.write(`\r\x1b[K${DIM}(poll error: ${e.message}, retrying in 2s)${RESET}\n`);
      refreshPrompt();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
