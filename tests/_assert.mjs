// Tiny assertion + test-runner harness shared by all tests/*.mjs files.
// Each test file: import { test, run, eq, ok, throws } from "./_assert.mjs"; ...; await run();
//
// Usage in a file:
//   test("name", async () => { eq(1+1, 2); });
//   await run();   // exits non-zero on any failure

const tests = [];
let currentFile = null;

export function test(name, fn) {
  tests.push({ name, fn, file: currentFile });
}

export function setFile(name) { currentFile = name; }

export function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`eq failed${msg ? " (" + msg + ")" : ""}: ${sa} !== ${sb}`);
}

export function ok(cond, msg) {
  if (!cond) throw new Error(`ok failed${msg ? ": " + msg : ""}`);
}

export function includes(haystack, needle, msg) {
  if (!String(haystack).includes(needle))
    throw new Error(`includes failed${msg ? " (" + msg + ")" : ""}: ${JSON.stringify(needle)} not in ${JSON.stringify(haystack).slice(0,200)}`);
}

export async function throws(fn, msg) {
  try { await fn(); }
  catch { return; }
  throw new Error(`expected throw${msg ? " (" + msg + ")" : ""}`);
}

export async function run() {
  let pass = 0, fail = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      fail++;
      failures.push({ name: t.name, err: e });
      console.log(`  ✗ ${t.name} — ${e.message}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.error(`\n[${f.name}]\n${f.err.stack || f.err.message}`);
    process.exit(1);
  }
}
