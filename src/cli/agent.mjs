// `murmur agent <name>` — headless supervisor mode (experimental).
//
// Most agent CLIs cannot hold a long-poll loop open across turns (see the
// per-agent matrix in the README), so an interactive window only reacts to
// mentions while a human keeps nudging it. This supervisor closes that gap:
// murmur owns the poll loop, and each incoming mention is handled by a fresh
// headless invocation of the agent CLI (`claude -p`, `codex exec`, ...).
// The supervisor also enforces the room contract in code instead of prompt:
// it posts the ack, heartbeats `wip:` while the CLI runs, and posts the reply.
//
// Cross-agent requests still go through the CLI's own permission config —
// headless mode grants intent, not new authority.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, callTool } from "../lib/mcp_client.mjs";
import { KNOWN_AGENTS } from "./detect.mjs";

const POLL_TIMEOUT_MS = 25000;
const HEARTBEAT_MS = 120000;
const CONTEXT_MESSAGES = 15;
const MAX_REPLY_CHARS = 12000;

// Per-agent headless invocation. `outFile` is used where the CLI can write
// the final message to a file, which is cleaner than scraping stdout.
const RUNNERS = {
  claude:  (prompt) => ({ argv: ["claude", "-p", prompt] }),
  codex:   (prompt, getOutFile) => {
    const outFile = getOutFile();
    return {
      argv: ["codex", "exec", "--skip-git-repo-check", "--output-last-message", outFile, prompt],
      outFile,
    };
  },
  gemini:  (prompt) => ({ argv: ["gemini", "-p", prompt] }),
  // --trust: headless mode refuses untrusted workspaces; the user explicitly
  // picked this cwd by launching the supervisor here.
  cursor:  (prompt) => ({ argv: ["cursor-agent", "-p", prompt, "--output-format", "text", "--trust"] }),
  copilot: (prompt) => ({ argv: ["copilot", "-p", prompt] }),
  agy:     (prompt) => ({ argv: ["agy", "-p", prompt] }),
};

// Agents runnable via `murmur agent` that have no murmur install adapter yet.
const EXTRA_AGENT_TYPES = { agy: "antigravity-cli" };

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const msgNum = (id) => parseInt(String(id).replace("msg_", ""), 10) || 0;

// Protocol status lines (ack/wip) don't need a model turn — reacting to them
// is what creates infinite agent-to-agent ping-pong.
const isStatusOnly = (body) => /^@[\w-]+\s+(ack|wip):/i.test(body.trim());

// Strict stop match: only "@<handle> stop" as the whole message (plus optional
// punctuation), so "@worker stop doing X and do Y" is a task, not a shutdown.
const isStopMessage = (body, handle) => {
  const t = body.trim();
  return t.includes("STOP TEST") || new RegExp(`^@${handle}\\s+stop[.!]*$`, "i").test(t);
};

function buildPrompt({ handle, agentType, context, message }) {
  const lines = [
    `You are @${handle} (${agentType}) in "murmur", a local multi-agent chat room shared with other coding agents and a human.`,
    `A supervisor invoked you headlessly to handle ONE incoming message. You cannot poll the room; the supervisor posts your reply for you.`,
    ``,
    `Recent room context (oldest first):`,
    ...context.map((m) => `@${m.sender}: ${m.body}`),
    ``,
    `New message from @${message.sender}:`,
    message.body,
    ``,
    `Instructions:`,
    `- If it asks a question, answer it. If it asks you to DO work, do it now with your normal tools (your usual approval rules apply), then summarize the outcome.`,
    `- Output ONLY the chat message to post, starting with "@${message.sender} ". Keep it short; put large payloads in files, branches, or PRs and reference them.`,
    `- If the message is a status update, pleasantry, or otherwise needs no reply, output exactly NO_REPLY.`,
    `- If it is ambiguous or destructive, reply asking @${message.sender} to clarify instead of acting.`,
  ];
  return lines.join("\n");
}

function runWorker({ argvBuild, prompt, taskTimeoutMs, onHeartbeat }) {
  // Lazy: only the runners that read the reply from a file (codex) pay for a
  // scratch dir; the stdout-based runners never touch the disk.
  let scratch = null;
  const getOutFile = () => {
    scratch = mkdtempSync(join(tmpdir(), "murmur-agent-"));
    return join(scratch, "last_message.txt");
  };
  const { argv, outFile } = argvBuild(prompt, getOutFile);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: process.cwd(),
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    const beat = setInterval(onHeartbeat, HEARTBEAT_MS);
    const killer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, taskTimeoutMs);
    child.on("error", (e) => {
      clearInterval(beat); clearTimeout(killer);
      resolve({ ok: false, reply: "", error: e.message });
      if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
    });
    child.on("exit", (code) => {
      clearInterval(beat); clearTimeout(killer);
      let reply = "";
      if (outFile && existsSync(outFile)) {
        try { reply = readFileSync(outFile, "utf8"); } catch {}
      }
      if (!reply.trim()) reply = stdout;
      reply = stripAnsi(reply).trim();
      const failed = timedOut || (code !== 0 && !reply);
      resolve({
        ok: !failed,
        reply,
        error: timedOut
          ? `task timed out after ${Math.round(taskTimeoutMs / 1000)}s`
          : failed
            ? (stripAnsi(stderr).trim().split("\n").pop() || `exit code ${code}`)
            : null,
      });
      if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
    });
  });
}

export async function agent({ name, handle, cmd, taskTimeoutS } = {}) {
  if (!name) {
    console.error("usage: murmur agent <name> [--handle=<h>] [--cmd=\"<custom command>\"] [--task-timeout=<s>]");
    process.exit(2);
  }
  const known = KNOWN_AGENTS.find((a) => a.name === name);
  let argvBuild;
  if (cmd) {
    // Custom command: split on whitespace but keep quoted arguments intact;
    // the prompt is appended as the final argument.
    const parts = (String(cmd).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((a) =>
      (a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))
        ? a.slice(1, -1)
        : a,
    );
    argvBuild = (prompt) => ({ argv: [...parts, prompt] });
  } else if (RUNNERS[name]) {
    argvBuild = RUNNERS[name];
  } else {
    console.error(`no built-in runner for '${name}' — pass --cmd=\"<command>\" (prompt is appended as the last argument)`);
    process.exit(2);
  }
  const myHandle = handle || known?.default_handle || name;
  const agentType = known?.agent_type || EXTRA_AGENT_TYPES[name] || "custom";
  const taskTimeoutMs = Math.max(10, taskTimeoutS || 600) * 1000;

  const conn = await connect(myHandle);
  const { client } = conn;
  const reg = await callTool(client, "register", {
    handle: myHandle, agent_type: agentType, roles: ["headless-worker"],
  });
  if (reg?.error) {
    console.error(`✗ ${reg.error} — try --handle=${reg.suggestion || myHandle + "-2"}`);
    process.exit(1);
  }
  let cursor = reg?.cursor || "msg_0";
  console.log(`✓ joined murmur as @${myHandle} (supervisor, headless ${cmd ? "custom cmd" : name})`);
  console.log(`  waiting for @${myHandle} mentions — Ctrl-C to leave`);

  let stopped = false;
  const leave = async (why) => {
    if (stopped) return;
    stopped = true;
    try { await callTool(client, "say", { handle: myHandle, message: `@human leaving (${why})` }); } catch {}
    console.log(`✓ left murmur (${why})`);
    try { await conn.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => { leave("interrupted"); });
  process.on("SIGTERM", () => { leave("terminated"); });

  const say = async (message) => {
    const r = await callTool(client, "say", { handle: myHandle, message });
    console.log(`→ ${message.split("\n")[0].slice(0, 120)}`);
    return r;
  };

  const handleMessage = async (m) => {
    console.log(`← @${m.sender}: ${m.body.split("\n")[0].slice(0, 120)}`);
    if (isStatusOnly(m.body)) {
      console.log(`  (status line — no action)`);
      return;
    }
    await say(`@${m.sender} ack: on it`);
    const hist = await callTool(client, "history", { limit: CONTEXT_MESSAGES });
    const context = (hist?.messages ?? []).slice().reverse().filter((c) => c.id !== m.id);
    const prompt = buildPrompt({ handle: myHandle, agentType, context, message: m });
    const res = await runWorker({
      argvBuild, prompt, taskTimeoutMs,
      onHeartbeat: () => {
        say(`@${m.sender} wip: still working`).catch(() => {});
      },
    });
    if (!res.ok) {
      await say(`@${m.sender} error: ${res.error}`.slice(0, MAX_REPLY_CHARS));
      return;
    }
    let reply = res.reply;
    if (!reply || /^NO_REPLY\b/.test(reply)) {
      console.log(`  (worker returned ${reply ? "NO_REPLY" : "no output"} — nothing posted)`);
      return;
    }
    if (reply.length > MAX_REPLY_CHARS) reply = reply.slice(0, MAX_REPLY_CHARS) + " …(truncated)";
    if (!new RegExp(`@${m.sender}\\b`).test(reply)) reply = `@${m.sender} ${reply}`;
    await say(reply);
  };

  while (!stopped) {
    let res;
    try {
      res = await callTool(client, "poll", { handle: myHandle, since: cursor, timeout_ms: POLL_TIMEOUT_MS });
    } catch (e) {
      if (stopped) break;
      console.log(`⟳ reconnecting… (${e.message})`);
      await new Promise((r) => setTimeout(r, 2000));
      // Re-register is idempotent; keep our cursor so no gap messages are lost.
      try { await callTool(client, "register", { handle: myHandle, agent_type: agentType, roles: ["headless-worker"] }); } catch {}
      continue;
    }
    for (const m of res?.messages ?? []) {
      if (m.id && msgNum(m.id) > msgNum(cursor)) cursor = m.id;
      if (m.sender === myHandle) continue;
      if (isStopMessage(m.body, myHandle)) {
        await leave(`stopped by @${m.sender}`);
        return;
      }
      if (!(m.mentions?.includes(myHandle) || m.mentions?.includes("all"))) continue;
      try {
        await handleMessage(m);
      } catch (e) {
        console.log(`✗ error handling ${m.id}: ${e.message}`);
      }
    }
    if (res?.cursor && msgNum(res.cursor) > msgNum(cursor)) cursor = res.cursor;
  }
}
