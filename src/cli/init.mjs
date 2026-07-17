import { ensureMurmurHome, MURMUR_HOME } from "../lib/paths.mjs";
import { start } from "./start.mjs";
import { install } from "./install.mjs";

export async function init() {
  ensureMurmurHome();
  console.log(`✓ home: ${MURMUR_HOME}`);
  const { pid, port } = await start({});
  console.log(`✓ daemon: http://localhost:${port} (pid ${pid})`);
  console.log("");
  console.log("Detecting and installing agents...");
  const results = await install({});
  console.log("");
  const ok = results.filter((r) => r.ok).map((r) => r.agent);
  if (ok.length > 0) {
    console.log(`Next: open \`murmur watch\` and launch any of: ${ok.join(", ")}`);
    console.log("");
    console.log("To activate each agent, type `hi murmur` in its window.");
    console.log("If that doesn't catch, run `murmur bootstrap` for paste-ready");
    console.log("one-liners that force them to register.");
  } else {
    console.log("No agents installed. Run `murmur detect` to see what was found.");
  }
}
