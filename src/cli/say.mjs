import { connect, callTool } from "../lib/mcp_client.mjs";

export async function say({ message, handle = "human" }) {
  if (!message) {
    console.error("usage: murmur say \"<message>\" [--as=<handle>]");
    process.exit(2);
  }
  const conn = await connect(handle);
  try {
    await callTool(conn.client, "register", { handle, agent_type: "human-cli" });
    const result = await callTool(conn.client, "say", { handle, message });
    if (result?.message_id) {
      console.log(`${result.message_id}  @${handle}: ${message}`);
    } else {
      console.log(JSON.stringify(result));
    }
  } finally {
    await conn.close();
  }
}
