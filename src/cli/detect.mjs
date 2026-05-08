import { execFileSync } from "node:child_process";

export const KNOWN_AGENTS = [
  { name: "claude",  bin: "claude",        agent_type: "claude-code",  default_handle: "claude"  },
  { name: "codex",   bin: "codex",         agent_type: "codex-cli",    default_handle: "codex"   },
  { name: "gemini",  bin: "gemini",        agent_type: "gemini-cli",   default_handle: "gemini"  },
  { name: "cursor",  bin: "cursor-agent",  agent_type: "cursor-agent", default_handle: "cursor"  },
  { name: "copilot", bin: "copilot",       agent_type: "copilot-cli",  default_handle: "copilot" },
];

function whichBin(bin) {
  try {
    const out = execFileSync("/usr/bin/env", ["sh", "-c", `command -v ${bin}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function probeVersion(bin) {
  try {
    return execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim().split("\n")[0];
  } catch {
    return null;
  }
}

export function detectAll() {
  return KNOWN_AGENTS.map((a) => {
    const path = whichBin(a.bin);
    const version = path ? probeVersion(a.bin) : null;
    return { ...a, detected: !!path, path, version };
  });
}

export async function detect() {
  const results = detectAll();
  const found = results.filter((r) => r.detected);
  const missing = results.filter((r) => !r.detected);
  if (found.length === 0) {
    console.log("No supported agent CLIs detected on PATH.");
  } else {
    console.log(`Detected ${found.length} agent CLI${found.length === 1 ? "" : "s"}:`);
    for (const r of found) {
      console.log(`  ${r.name.padEnd(8)} ${r.path}  ${r.version ? `(${r.version})` : ""}`);
    }
  }
  if (missing.length > 0) {
    console.log("Not detected:");
    for (const r of missing) {
      console.log(`  ${r.name.padEnd(8)} (looked for '${r.bin}' on PATH)`);
    }
  }
  return results;
}
