import { say } from "./say.mjs";

// `murmur poke <handle>` — post a wake mention as @human.
// Thin wrapper over `say` so any change to send semantics stays in one place.
export async function poke({ handle }) {
  if (!handle) {
    console.error('usage: murmur poke <handle>');
    process.exit(2);
  }
  const target = handle.replace(/^@/, "");
  const message = `@${target} still alive? please ack`;
  await say({ message, handle: "human" });
}
