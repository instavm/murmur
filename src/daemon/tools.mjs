import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function initDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions TEXT NOT NULL,
      reply_to INTEGER,
      ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      handle TEXT PRIMARY KEY,
      agent_type TEXT,
      roles TEXT,
      label TEXT,
      joined_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
  `);
  return db;
}

export function makeAuditor(auditPath, label) {
  mkdirSync(dirname(auditPath), { recursive: true });
  const fn = (entry) => {
    appendFileSync(
      auditPath,
      JSON.stringify({ ts: new Date().toISOString(), agent_label: label, ...entry }) + "\n",
    );
  };
  fn.label = label;
  return fn;
}

export const parseMentions = (body) =>
  [...body.matchAll(/(?<![A-Za-z0-9_])@([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);

export const cursorToInt = (c) => {
  if (!c) return 0;
  const m = String(c).match(/^msg_(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
};

export function registerTools(server, { db, audit, shutdown }) {
  const currentCursor = () => {
    const row = db.prepare("SELECT MAX(id) AS id FROM messages").get();
    return `msg_${row?.id ?? 0}`;
  };
  const touchLastSeen = (handle) => {
    if (!handle) return;
    db.prepare("UPDATE participants SET last_seen=? WHERE handle=?").run(
      new Date().toISOString(),
      handle,
    );
  };

  server.tool(
    "register",
    "Register as a participant in the murmur room. Idempotent for the same handle on the same agent surface.",
    {
      handle: z.string(),
      agent_type: z.string(),
      roles: z.array(z.string()).optional(),
    },
    async ({ handle, agent_type, roles }) => {
      const start = Date.now();
      const now = new Date().toISOString();
      const existing = db
        .prepare("SELECT label FROM participants WHERE handle=?")
        .get(handle);
      let result;
      if (existing && existing.label !== audit.label) {
        result = { error: `handle '${handle}' is taken`, suggestion: `${handle}-2` };
      } else {
        db.prepare(
          `INSERT INTO participants (handle, agent_type, roles, label, joined_at, last_seen)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(handle) DO UPDATE SET last_seen=excluded.last_seen, agent_type=excluded.agent_type`,
        ).run(handle, agent_type, JSON.stringify(roles ?? []), audit.label, now, now);
        result = { handle, cursor: currentCursor(), room: "default" };
      }
      audit({
        tool: "register",
        handle,
        params: { handle, agent_type, roles },
        result_summary: result,
        duration_ms: Date.now() - start,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "say",
    "Publish a message to the room. @<handle> mentions are parsed automatically.",
    { handle: z.string(), message: z.string().max(16384), reply_to: z.string().optional() },
    async ({ handle, message, reply_to }) => {
      const start = Date.now();
      const now = new Date().toISOString();
      const mentions = parseMentions(message);
      const info = db
        .prepare(
          "INSERT INTO messages (sender, body, mentions, reply_to, ts) VALUES (?,?,?,?,?)",
        )
        .run(handle, message, JSON.stringify(mentions), cursorToInt(reply_to) || null, now);
      touchLastSeen(handle);
      const result = { message_id: `msg_${info.lastInsertRowid}`, timestamp: now };
      audit({
        tool: "say",
        handle,
        params: { message: message.slice(0, 200), reply_to },
        result_summary: result,
        duration_ms: Date.now() - start,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "poll",
    "Long-poll for new messages. Blocks up to timeout_ms (default 30000) until a new message arrives. Returns immediately with empty messages on timeout — that is NOT a stop signal.",
    {
      handle: z.string(),
      since: z.string(),
      timeout_ms: z.number().int().min(0).max(60000).default(30000).optional(),
      mentions: z.array(z.string()).nullable().optional(),
    },
    async ({ handle, since, timeout_ms = 30000, mentions }) => {
      const start = Date.now();
      const sinceInt = cursorToInt(since);
      const filter = mentions && mentions.length > 0 ? mentions : null;
      const deadline = start + timeout_ms;
      let rows = [];
      while (Date.now() < deadline && !shutdown.value) {
        const candidates = db
          .prepare("SELECT id, sender, body, mentions, ts FROM messages WHERE id > ? ORDER BY id ASC")
          .all(sinceInt);
        rows = filter
          ? candidates.filter((r) => JSON.parse(r.mentions).some((m) => filter.includes(m)))
          : candidates;
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      touchLastSeen(handle);
      const newCursor = rows.length ? `msg_${rows[rows.length - 1].id}` : `msg_${sinceInt}`;
      const result = {
        messages: rows.map((r) => ({
          id: `msg_${r.id}`,
          sender: r.sender,
          body: r.body,
          mentions: JSON.parse(r.mentions),
          timestamp: r.ts,
        })),
        cursor: newCursor,
      };
      audit({
        tool: "poll",
        handle,
        params: { since, timeout_ms, mentions },
        result_summary: { messages: rows.length, cursor: newCursor },
        duration_ms: Date.now() - start,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "who",
    "List current participants in the room with their last-seen timestamps.",
    {},
    async () => {
      const start = Date.now();
      const rows = db.prepare("SELECT handle, agent_type, roles, last_seen FROM participants").all();
      const result = {
        participants: rows.map((r) => ({
          handle: r.handle,
          agent_type: r.agent_type,
          roles: JSON.parse(r.roles || "[]"),
          last_seen: r.last_seen,
        })),
      };
      audit({ tool: "who", params: {}, result_summary: { n: rows.length }, duration_ms: Date.now() - start });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "history",
    "Read recent messages from the room, newest first.",
    {
      limit: z.number().int().min(1).max(500).default(50).optional(),
      before: z.string().optional(),
    },
    async ({ limit = 50, before }) => {
      const start = Date.now();
      const beforeInt = before ? cursorToInt(before) : Number.MAX_SAFE_INTEGER;
      const rows = db
        .prepare("SELECT id, sender, body, mentions, ts FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?")
        .all(beforeInt, limit);
      const result = {
        messages: rows.map((r) => ({
          id: `msg_${r.id}`,
          sender: r.sender,
          body: r.body,
          mentions: JSON.parse(r.mentions),
          timestamp: r.ts,
        })),
        cursor: rows.length ? `msg_${rows[rows.length - 1].id}` : `msg_0`,
        has_more: rows.length === limit,
      };
      audit({ tool: "history", params: { limit, before }, result_summary: { n: rows.length }, duration_ms: Date.now() - start });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
