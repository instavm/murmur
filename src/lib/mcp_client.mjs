import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { PORT_FILE, DEFAULT_PORT } from "./paths.mjs";

export function daemonUrl(label) {
  const port = existsSync(PORT_FILE)
    ? parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10) || DEFAULT_PORT
    : DEFAULT_PORT;
  return `http://localhost:${port}/mcp/${label}`;
}

export async function connect(label) {
  const url = daemonUrl(label);
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: `murmur-cli-${label}`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, close: async () => { await client.close(); } };
}

export async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
