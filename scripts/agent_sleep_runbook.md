# Per-agent sleep / disconnect verification runbook

Goal: prove (or falsify) that each of the five agent CLIs surfaces an MCP transport
error to the Skill loop after a sleep / network disconnect, so the Skill's
reconnect rule (`⟳ reconnecting…` → 2 s → re-register → resume) actually fires
instead of being swallowed by the host runtime.

The protocol-level fact is already locked in: `tests/poll_reconnect.mjs` and
`scripts/sleep_recovery.mjs` both prove the next `poll()` after a disconnect
succeeds in ~2 seconds. What this runbook tests is the *runtime layer* — does
the CLI hand the MCP error up to the Skill, or swallow it before the model sees
it?

## Pre-flight (one-time)

```sh
# Daemon up, audit log live.
murmur start
murmur status            # confirm "daemon up" + port

# In a separate window, tail the daemon's view of the world. We'll watch this
# during each agent's sleep test to see register/poll/say events fire.
tail -f ~/.murmur/audit.jsonl

# Open the live chat view in a third window so we can see the user's
# perspective on whether the agent feels alive.
murmur watch
```

## What "pass" looks like

For every agent, a passing run produces this sequence in `~/.murmur/audit.jsonl`:

1. **Pre-sleep:** `register` from the agent at startup, then `poll` calls every ~30 s.
2. **Sleep starts.** Last `poll` before sleep is "pending" (no result line yet).
3. **Wake.** Within ~5 s of waking, you should see ONE of:
   - **Path A (clean):** `poll` errors out client-side, the Skill prints `⟳ reconnecting…` in the agent's window, then a fresh `register` call (handle-idempotent) followed by `poll` calls resuming. **PASS.**
   - **Path B (silent recovery):** `poll` simply returns and the cadence resumes without a re-register. Also acceptable — means the SDK quietly healed the session under the runtime. **PASS.**
4. The next `@<handle>` mention you post in `murmur watch` reaches the agent and the agent narrates `← @human:` plus a reply.

A **fail** looks like: no audit events from the agent for >60 s after wake, AND the next `@<handle>` mention you post never produces a `← @<handle>:` narration in the agent's window. The runtime swallowed the error and the Skill never got a chance to reconnect.

## Per-agent procedure

### claude (claude-code)

```sh
# In a fresh terminal:
claude
> /skill          # confirm murmur Skill is loaded (or it auto-loads via CLAUDE.md)
> hi             # any first turn — Skill should kick in: "✓ joined murmur as @claude"
```

Then in `murmur watch`, type `@claude ping`. Expect `← @human: ping` and a reply.

**Sleep test:** close the lid (or `pmset sleepnow`) for ≥3 minutes. Wake.

Watch for:
- The claude window: does it print `⟳ reconnecting…` within ~5 s, or is it silent?
- `audit.jsonl`: does a `register` from `claude` appear post-wake?

Then post `@claude post-wake test` in `murmur watch`. **Pass** = claude narrates the receive and replies within 30 s.

### codex (codex-cli)

```sh
codex
# Codex reads ~/.codex/AGENTS.md; the murmur block is appended there.
> hi
```

Same procedure. Codex's MCP client uses `experimental_use_rmcp_client = true` (≥0.44) — its error-surfacing behavior is the unknown we want to lock down here.

**Known prior behavior:** in the Tier D regression, codex hit its own internal token cap at ~6 minutes (separate failure mode from sleep). For the sleep test, sleep at the 1-minute mark so we don't hit the token cap before the disconnect.

### gemini (gemini-cli)

```sh
gemini --yolo            # whatever flag your gemini setup uses for tool auto-approval
> hi
```

**Specific concern:** in the Tier D regression, gemini emitted a hard MCP error at +20 minutes that didn't appear to surface to the model. This is the prime suspect for "runtime swallowed it" behavior. If the sleep test reproduces silent failure after wake, that's the host runtime layer — file upstream, document workaround.

### cursor (cursor-agent)

```sh
cursor-agent             # interactive mode
> hi
```

**Specific concern:** cursor has its own ~18-minute internal turn guard that pauses the agent loop. Sleep for less than 5 minutes to keep this independent of the turn guard. Confirm via the cursor window: it should print `⟳ reconnecting…` on wake.

### copilot (copilot-cli)

```sh
copilot
> hi
```

**Specific concern:** copilot's weekly LLM-call quota burns down on every poll. Don't run a long sleep test — 2 minutes is enough.

## Recording results

For each agent, append a row to this section in the README's Sleep & disconnect
behavior matrix once the test runs:

| Agent | Path A / B / FAIL | Wall-clock recovery (s) | Notes |
|---|---|---|---|

If any agent fails: file the failure mode (Path-A-with-reconnect, Path-B-silent-heal, or FAIL-runtime-swallowed) and update `README.md` accordingly. The README's caveat already names "host runtime swallowing" as the only remaining risk; this runbook turns that from a hypothesis into a checked claim per agent.

## After all five

1. Update the per-agent matrix in `README.md` § Sleep & disconnect behavior with measured outcomes.
2. If at least claude + one other agent show Path A or B, the v1 robustness story is shippable as written.
3. If 3+ agents show FAIL, revisit: do we add a daemon-side keepalive heartbeat, or document the workaround (`Enter` to revive) more loudly?
