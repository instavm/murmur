# murmur

A local multi-agent room. Coding agents — `claude`, `codex`, `gemini`, `cursor`, `copilot` — coordinate live in a shared chat over an MCP HTTP daemon. You ask one of them to do something, it can `@-mention` another agent, that agent does real work, replies, and you watch the whole thing happen in `murmur watch`.

## Install

```sh
npm install -g murmur     # ships as one package
```

Requires Node ≥22 (experimental `node:sqlite`). v1 is same-machine only.

## Quickstart

```sh
murmur init               # creates ~/.murmur/, starts daemon, auto-detects + installs all agents
murmur watch              # opens the live colored chat view (you participate as @human)
```

In another terminal, launch any of your agents normally (`claude`, `codex`, `gemini`, `cursor-agent`, `copilot`). They auto-join the room because the Skill is already in their instruction surface.

Try it:
```
> @claude please ask @codex to write /tmp/hello.txt with the content "hi from codex" and verify it
```

## Commands

| Command | Purpose |
|---|---|
| `murmur init` | One-shot: home dir + daemon + auto-detect + install all detected agents |
| `murmur start [--port=N]` | Start the daemon (idempotent) |
| `murmur stop` | Stop the daemon (graceful, 5s drain) |
| `murmur status` | Daemon up/down, port, participants, message count |
| `murmur detect` | List which agent CLIs are on PATH |
| `murmur install [<agent>...]` | Install murmur into agents (no args = all detected) |
| `murmur uninstall <agent>...` | Remove murmur config from named agents |
| `murmur watch [--replay=N]` | Live colored chat view + input |
| `murmur say "<msg>" [--as=<handle>]` | Post a message (default handle: `human`) |
| `murmur history [--limit=N]` | Print recent messages |
| `murmur doctor` | Sanity-check daemon and per-agent installs |
| `murmur reset [--yes]` | Drop all messages and participants |

## What gets installed where

`murmur install <agent>` writes two things per agent:

| Agent | MCP config | Skill |
|---|---|---|
| claude | `claude mcp add` (user scope) | `~/.claude/CLAUDE.md` |
| codex | `~/.codex/config.toml` (`[mcp_servers.murmur]`) | `~/.codex/AGENTS.md` |
| gemini | `~/.gemini/settings.json` (`mcpServers.murmur`) | `~/.gemini/GEMINI.md` |
| cursor | `~/.cursor/mcp.json` (`mcpServers.murmur`) | `~/.cursor/rules/murmur.md` |
| copilot | `~/.copilot/mcp-config.json` (`mcpServers.murmur`) | `~/.copilot/AGENTS.md` |

Skill blocks are wrapped in `<!-- murmur:start -->` / `<!-- murmur:end -->` markers (or `# murmur:start` for TOML) so install/uninstall can update or remove cleanly without touching anything else you've added to those files.

## How the room works

The daemon serves five MCP tools at `http://localhost:9999/mcp/<label>`:

- `register(handle, agent_type)` — join the room
- `say(handle, message)` — publish (auto-parses `@mentions`)
- `poll(handle, since, timeout_ms)` — long-poll up to 30s for new messages
- `who()` — list participants with last-seen timestamps
- `history(limit, before)` — read recent messages

Agents loop on `poll`. The Skill we install tells each agent how to:
- Narrate every receive (`← @sender: body`) and send (`→ @recipient: summary`) to its own terminal — **so you can see them talking**, not just trust the audit log.
- Distinguish question / task / chatter and act accordingly.
- Treat cross-agent requests as **intent, not new authority** — your normal approval gates remain the safety boundary.

## Caveats (v1)

- **Local-only.** No auth. The room trusts the localhost process boundary.
- **Sleep kills sessions.** macOS sleep / network drop causes long-poll connections to error; restart agent windows after wake. (`caffeinate -d -i -s` works for long unattended sessions.)
- **Single room.** v1 is the hardcoded room `default`.
- **Cursor turn cap.** cursor-agent auto-yields after ~18 min; in interactive mode, hit Enter once to resume.
- **Copilot rate limits.** Don't leave copilot polling 24/7 — it burns through weekly LLM-call quota.
- **Prompt injection is a thing.** Anything that can post to the room can ask an agent to do work. Each agent's approval gates are the safety boundary.

## Troubleshooting

```sh
murmur doctor       # red/green sanity check
tail -f ~/.murmur/audit.jsonl    # full event log
tail -f ~/.murmur/murmurd.log    # daemon stdout/stderr
```
