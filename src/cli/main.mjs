// Main CLI dispatch. bin/murmur runs the Node-version + node:sqlite preflight
// then dynamically imports this module so we never trigger a node:sqlite static
// import on a too-old Node.
import { start } from "./start.mjs";
import { stop } from "./stop.mjs";
import { status } from "./status.mjs";
import { say } from "./say.mjs";
import { history } from "./history.mjs";
import { detect } from "./detect.mjs";
import { install, uninstall } from "./install.mjs";
import { init } from "./init.mjs";
import { watch } from "./watch.mjs";
import { doctor } from "./doctor.mjs";
import { poke } from "./poke.mjs";
import { reset } from "./reset.mjs";
import { enroll } from "./enroll.mjs";
import { bootstrap } from "./bootstrap.mjs";
import { agent } from "./agent.mjs";

export const HELP = `murmur — local multi-agent room

Usage:
  murmur init                              start daemon + install into all detected agents
  murmur start [--port=N] [--foreground]   start the daemon
  murmur stop                              stop the daemon
  murmur status                            show daemon + room state
  murmur say "<message>" [--as=<handle>]   post a message (default handle: human)
  murmur history [--limit=N] [--before=msg_N]   print recent messages
  murmur detect                            list installed agent CLIs on PATH
  murmur install [<agent>...] [--poll-timeout=<ms>]   install murmur into agents (no args = all detected)
  murmur uninstall <agent>...              remove murmur config from named agents
  murmur watch [--replay=N]                live colored chat view + input
  murmur agent <name> [--handle=<h>] [--cmd="<command>"] [--task-timeout=<s>]
                                           run an unattended headless worker:
                                           murmur polls the room and invokes the
                                           agent CLI per mention (experimental)
  murmur doctor                            sanity-check daemon + installed agents
  murmur poke <handle>                     post a wake mention to a stalled agent
  murmur enroll <handle> [--agent-type=<t>] [--poll-timeout=<ms>] [--format=text|json|skill|mcp]
                                           print MCP config + Skill for any agent
                                           (use this for unsupported agents — opencode, aider, etc.)
  murmur reset [--yes]                     drop all messages and participants
  murmur bootstrap [<handle>] [--mode=cooperative|listener]
                                           print paste-ready one-liners to
                                           force agents to join (use when
                                           "hi murmur" isn't reliable)
  murmur help                              show this help
`;

export async function run(argv) {
  const [cmd, ...rest] = argv;
  const flags = Object.fromEntries(
    rest.map((a) => {
      const m = a.match(/^--([^=]+)=(.*)$/);
      if (m) return [m[1], m[2]];
      if (a.startsWith("--")) return [a.slice(2), true];
      return [a, true];
    }),
  );

  try {
    switch (cmd) {
      case "init":
        await init();
        break;
      case "start":
        await start({
          port: flags.port ? parseInt(flags.port, 10) : undefined,
          foreground: !!flags.foreground,
        });
        break;
      case "stop":
        await stop();
        break;
      case "status":
        await status();
        break;
      case "say": {
        const positional = rest.find((a) => !a.startsWith("--"));
        await say({ message: positional, handle: flags.as || "human" });
        break;
      }
      case "detect":
        await detect();
        break;
      case "install": {
        const targets = rest.filter((a) => !a.startsWith("--"));
        const pollTimeoutMs = flags["poll-timeout"] ? parseInt(flags["poll-timeout"], 10) : undefined;
        await install({ targets, all: !!flags.all, pollTimeoutMs });
        break;
      }
      case "uninstall": {
        const targets = rest.filter((a) => !a.startsWith("--"));
        await uninstall({ targets });
        break;
      }
      case "history":
        await history({
          limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
          before: flags.before,
        });
        break;
      case "watch":
        await watch({
          replay: flags.replay ? parseInt(flags.replay, 10) : undefined,
          handle: flags.as || "human",
        });
        break;
      case "doctor":
        await doctor();
        break;
      case "agent": {
        const target = rest.find((a) => !a.startsWith("--"));
        await agent({
          name: target,
          handle: flags.handle,
          cmd: flags.cmd,
          taskTimeoutS: flags["task-timeout"] ? parseInt(flags["task-timeout"], 10) : undefined,
        });
        break;
      }
      case "poke": {
        const target = rest.find((a) => !a.startsWith("--"));
        await poke({ handle: target });
        break;
      }
      case "enroll": {
        const target = rest.find((a) => !a.startsWith("--"));
        await enroll({
          handle: target,
          agentType: flags["agent-type"],
          pollTimeoutMs: flags["poll-timeout"] ? parseInt(flags["poll-timeout"], 10) : undefined,
          format: flags.format || "text",
        });
        break;
      }
      case "reset":
        await reset({ yes: !!flags.yes });
        break;
      case "bootstrap": {
        const target = rest.find((a) => !a.startsWith("--"));
        await bootstrap({ handle: target, mode: flags.mode });
        break;
      }
      case "help":
      case "--help":
      case "-h":
      case undefined:
        console.log(HELP);
        break;
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.log(HELP);
        process.exit(2);
    }
  } catch (e) {
    console.error(`murmur ${cmd}: ${e.message}`);
    process.exit(1);
  }
}
