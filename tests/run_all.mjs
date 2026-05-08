// Runs every test file in this directory (excluding _* helpers) sequentially,
// each in its own subprocess so module-load-time env mutations don't leak.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname)
  .filter((f) => f.endsWith(".mjs") && !f.startsWith("_") && f !== "run_all.mjs")
  .sort();

let failed = 0;
const results = [];
for (const f of files) {
  console.log(`\n── ${f} ──`);
  const r = spawnSync(process.execPath, [join(__dirname, f)], { stdio: "inherit" });
  const ok = r.status === 0;
  results.push({ file: f, ok, status: r.status });
  if (!ok) failed++;
}

console.log("\n══ summary ══");
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.file}${r.ok ? "" : ` (exit ${r.status})`}`);
console.log(`\n${results.length - failed}/${results.length} files passed`);
process.exit(failed ? 1 : 0);
