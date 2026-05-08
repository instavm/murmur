import { connect, callTool } from "../lib/mcp_client.mjs";

export async function history({ limit = 50, before } = {}) {
  const conn = await connect("_cli");
  try {
    const result = await callTool(conn.client, "history", {
      limit,
      ...(before ? { before } : {}),
    });
    const msgs = (result?.messages ?? []).slice().reverse();
    if (msgs.length === 0) {
      console.log("(no messages yet)");
      return;
    }
    for (const m of msgs) {
      const ts = m.timestamp.replace("T", " ").slice(0, 19);
      console.log(`${ts}  ${m.id}  @${m.sender}: ${m.body}`);
    }
    if (result?.has_more) console.log(`(more — pass --before=${result.cursor})`);
  } finally {
    await conn.close();
  }
}
