import { detectAll } from "./detect.mjs";

const ADAPTERS = {
  claude:  () => import("./install/claude.mjs"),
  codex:   () => import("./install/codex.mjs"),
  gemini:  () => import("./install/gemini.mjs"),
  cursor:  () => import("./install/cursor.mjs"),
  copilot: () => import("./install/copilot.mjs"),
};

function pad(s, n) { return String(s).padEnd(n); }

export async function install({ targets, all = false, pollTimeoutMs } = {}) {
  const detected = detectAll();
  const wanted = (() => {
    if (targets && targets.length > 0) {
      return targets.map((name) => {
        const d = detected.find((x) => x.name === name);
        if (!d) return { name, detected: false, requested: true };
        return { ...d, requested: true };
      });
    }
    return detected.filter((d) => d.detected).map((d) => ({ ...d, requested: false }));
  })();
  if (wanted.length === 0) {
    console.log("No agents to install. Try `murmur detect` to see what's on PATH.");
    return [];
  }
  const results = [];
  for (const a of wanted) {
    if (!a.detected) {
      console.log(`✗ ${pad(a.name, 8)} not detected on PATH — skipped`);
      results.push({ agent: a.name, skipped: true, reason: "not detected" });
      continue;
    }
    const loader = ADAPTERS[a.name];
    if (!loader) {
      console.log(`⚠ ${pad(a.name, 8)} adapter not implemented yet — skipped`);
      results.push({ agent: a.name, skipped: true, reason: "no adapter" });
      continue;
    }
    try {
      const mod = await loader();
      const r = await mod.install({ pollTimeoutMs });
      console.log(`✓ ${pad(a.name, 8)} ${a.version ? `(${a.version})` : ""}`);
      for (const step of r) {
        const tag = step.kind === "mcp" ? "mcp" : "skill";
        const detail = step.detail || step.path || "";
        console.log(`    ${tag}: ${step.action}  ${detail}`);
      }
      results.push({ agent: a.name, ok: true, steps: r });
    } catch (e) {
      console.log(`✗ ${pad(a.name, 8)} ${e.message}`);
      results.push({ agent: a.name, ok: false, error: e.message });
    }
  }
  return results;
}

export async function uninstall({ targets } = {}) {
  if (!targets || targets.length === 0) {
    console.error("usage: murmur uninstall <agent> [agent...]");
    process.exit(2);
  }
  for (const name of targets) {
    const loader = ADAPTERS[name];
    if (!loader) {
      console.log(`⚠ ${name}: adapter not implemented yet`);
      continue;
    }
    try {
      const mod = await loader();
      const r = await mod.uninstall({});
      console.log(`✓ ${name}`);
      for (const step of r) {
        const tag = step.kind === "mcp" ? "mcp" : "skill";
        const detail = step.detail || step.path || "";
        console.log(`    ${tag}: ${step.action}  ${detail}`);
      }
    } catch (e) {
      console.log(`✗ ${name}: ${e.message}`);
    }
  }
}
