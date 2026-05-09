#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, unlinkSync, appendFileSync } from "node:fs";
import {
  MURMUR_HOME,
  DB_PATH,
  AUDIT_PATH,
  PID_FILE,
  PORT_FILE,
  DEFAULT_PORT,
  ensureMurmurHome,
} from "../lib/paths.mjs";
import { initDb, makeAuditor, registerTools } from "./tools.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const PORT = parseInt(args.port || process.env.MURMUR_PORT || String(DEFAULT_PORT), 10);
const BIND = process.env.MURMUR_BIND || "127.0.0.1";

ensureMurmurHome();

if (existsSync(PID_FILE)) {
  const oldPid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  if (oldPid && isAlive(oldPid)) {
    console.error(`murmurd already running (pid ${oldPid}). Use 'murmur stop' first.`);
    process.exit(1);
  }
  try { unlinkSync(PID_FILE); } catch {}
}
writeFileSync(PID_FILE, String(process.pid));
writeFileSync(PORT_FILE, String(PORT));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const db = initDb(DB_PATH);
const shutdown = { value: false };
const sessions = new Map();

function buildServerForLabel(label) {
  const audit = makeAuditor(AUDIT_PATH, label);
  const server = new McpServer({ name: "murmurd", version: "0.1.0" });
  registerTools(server, { db, audit, shutdown });
  return server;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/mcp\/([a-zA-Z0-9_-]+)\/?$/);
  if (!m) {
    res.writeHead(404).end("not found");
    return;
  }
  const label = m[1];
  const sessionId = req.headers["mcp-session-id"];

  try {
    let entry;
    if (sessionId && sessions.has(sessionId)) {
      entry = sessions.get(sessionId);
    } else if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, label });
          makeAuditor(AUDIT_PATH, label)({ tool: "_session_init", session_id: sid });
        },
      });
      const server = buildServerForLabel(label);
      await server.connect(transport);
      entry = { transport, label };
    } else {
      res.writeHead(400).end("unknown session");
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    await entry.transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("[murmurd] error:", e);
    if (!res.headersSent) {
      res.writeHead(500).end(String(e?.message || e));
    }
  }
});

httpServer.listen(PORT, BIND, () => {
  console.log(`[murmurd] listening on http://${BIND}:${PORT}/mcp/<label>`);
  appendFileSync(
    AUDIT_PATH,
    JSON.stringify({
      ts: new Date().toISOString(),
      agent_label: "_daemon",
      tool: "_startup",
      params: { port: PORT, bind: BIND, home: MURMUR_HOME, pid: process.pid },
    }) + "\n",
  );
});

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdown.value = true;
  console.log(`[murmurd] ${signal} received, draining...`);
  httpServer.close(() => {
    try { unlinkSync(PID_FILE); } catch {}
    try { unlinkSync(PORT_FILE); } catch {}
    appendFileSync(
      AUDIT_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        agent_label: "_daemon",
        tool: "_shutdown",
        params: { signal },
      }) + "\n",
    );
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[murmurd] forced exit after 5s drain timeout");
    try { unlinkSync(PID_FILE); } catch {}
    try { unlinkSync(PORT_FILE); } catch {}
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
