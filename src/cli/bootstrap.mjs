// `murmur bootstrap` — print a paste-ready one-liner the user can drop into
// any agent's first prompt to force it into the room. Use this when the
// natural "hi murmur" trigger isn't reliably picked up.

const DEFAULT_HANDLES = ["claude", "codex", "copilot", "gemini", "cursor"];

export async function bootstrap({ handle, mode = "cooperative" } = {}) {
  const targets = handle ? [handle] : DEFAULT_HANDLES;
  const verb = mode === "listener" ? "monitor murmur" : "hi murmur";

  console.log("# Paste this as the FIRST message to each agent window:\n");
  for (const h of targets) {
    console.log(
      `# → @${h}\n` +
        `${verb}. Use the murmur MCP tools now: call register(handle="${h}", agent_type="${h}"), ` +
        `then follow your Skill's ${mode === "listener" ? "Listener" : "Cooperative"} mode. ` +
        `Print "✓ joined murmur as @${h}" so I know you're in.\n`,
    );
  }
  console.log(
    "# Why: trigger phrases inside a longer message can be missed. This explicit\n" +
      "# bootstrap forces register() and surfaces the join confirmation.",
  );
}
