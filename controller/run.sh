#!/usr/bin/env bash
# Launch enabled coding agents in parallel headless mode against the stub
# Murmur server. Each agent gets the same join+poll prompt. Sleeps DURATION_S
# seconds, then injects STOP TEST and kills any stragglers.
#
# Env:
#   DURATION_S        total run length in seconds (default 1800)
#   AGENTS            comma-separated subset of: claude,codex,gemini,cursor,copilot
#                     (default: all five)
#   MURMUR_TEST_MODE  forwarded to stub (default: always-empty)

set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

DURATION_S=${DURATION_S:-1800}
AGENTS=${AGENTS:-claude,codex,gemini,cursor,copilot}
MODE=${MURMUR_TEST_MODE:-always-empty}

RUN_ID=$(date -u +%Y-%m-%dT%H-%M-%SZ)
RUN_DIR="$ROOT/runs/$RUN_ID"
LOG_DIR="$RUN_DIR/logs"
PROMPT_DIR="$RUN_DIR/prompts"
mkdir -p "$LOG_DIR" "$PROMPT_DIR"

export MURMUR_DB="$RUN_DIR/db.sqlite"
export MURMUR_AUDIT="$RUN_DIR/audit.jsonl"
export MURMUR_TEST_MODE="$MODE"

# Pre-create the DB schema by spawning stub once and immediately exiting.
( node "$ROOT/server/stub.mjs" --label=_init </dev/null >/dev/null 2>&1 & sleep 0.3; kill $! 2>/dev/null; wait $! 2>/dev/null ) || true

write_prompt() {
  local handle=$1 agent=$2
  local out="$PROMPT_DIR/$handle.md"
  sed -e "s|<HANDLE>|$handle|g" -e "s|<AGENT>|$agent|g" "${PROMPT_FILE:-$ROOT/controller/prompt.md}" > "$out"
  echo "$out"
}

mcp_json_inline() {
  local label=$1
  printf '{"mcpServers":{"murmur":{"command":"node","args":["%s/server/stub.mjs","--label=%s"],"env":{"MURMUR_DB":"%s","MURMUR_AUDIT":"%s","MURMUR_TEST_MODE":"%s"}}}}' \
    "$ROOT" "$label" "$MURMUR_DB" "$MURMUR_AUDIT" "$MODE"
}

enabled() { [[ ",$AGENTS," == *",$1,"* ]]; }

start_pid() {
  local label=$1 pid=$2
  echo "$pid" > "$LOG_DIR/$label.pid"
  echo "[$RUN_ID] $label started pid=$pid" | tee -a "$LOG_DIR/_controller.log"
}

# ---- Claude ----
if enabled claude; then
  P=$(write_prompt claude_bot claude-code)
  PROMPT=$(cat "$P")
  MCP=$(mcp_json_inline claude)
  claude -p "$PROMPT" \
    --mcp-config "$MCP" \
    --dangerously-skip-permissions \
    --output-format text \
    >"$LOG_DIR/claude.log" 2>&1 &
  start_pid claude $!
fi

# ---- Codex ----
if enabled codex; then
  P=$(write_prompt codex_bot codex-cli)
  PROMPT=$(cat "$P")
  codex exec --full-auto --skip-git-repo-check \
    -c "model=\"gpt-5\"" \
    -c "model_reasoning_effort=\"medium\"" \
    -c "mcp_servers.murmur.command=\"node\"" \
    -c "mcp_servers.murmur.args=[\"$ROOT/server/stub.mjs\",\"--label=codex\"]" \
    -c "mcp_servers.murmur.env={MURMUR_DB=\"$MURMUR_DB\",MURMUR_AUDIT=\"$MURMUR_AUDIT\",MURMUR_TEST_MODE=\"$MODE\"}" \
    "$PROMPT" \
    >"$LOG_DIR/codex.log" 2>&1 &
  start_pid codex $!
fi

# ---- Gemini ----
if enabled gemini; then
  mkdir -p "$ROOT/.gemini"
  cat > "$ROOT/.gemini/settings.json" <<JSON
{
  "mcpServers": {
    "murmur": {
      "command": "node",
      "args": ["$ROOT/server/stub.mjs", "--label=gemini"],
      "env": {"MURMUR_DB": "$MURMUR_DB", "MURMUR_AUDIT": "$MURMUR_AUDIT", "MURMUR_TEST_MODE": "$MODE"}
    }
  }
}
JSON
  P=$(write_prompt gemini_bot gemini-cli)
  PROMPT=$(cat "$P")
  gemini -p "$PROMPT" --yolo \
    >"$LOG_DIR/gemini.log" 2>&1 &
  start_pid gemini $!
fi

# ---- Cursor ----
if enabled cursor; then
  mkdir -p "$ROOT/.cursor"
  cat > "$ROOT/.cursor/mcp.json" <<JSON
{"mcpServers":{"murmur":{"command":"node","args":["$ROOT/server/stub.mjs","--label=cursor"],"env":{"MURMUR_DB":"$MURMUR_DB","MURMUR_AUDIT":"$MURMUR_AUDIT","MURMUR_TEST_MODE":"$MODE"}}}}
JSON
  P=$(write_prompt cursor_bot cursor-agent)
  PROMPT=$(cat "$P")
  cursor-agent -p "$PROMPT" --force --approve-mcps --output-format text \
    >"$LOG_DIR/cursor.log" 2>&1 &
  start_pid cursor $!
fi

# ---- Copilot ----
if enabled copilot; then
  P=$(write_prompt copilot_bot copilot-cli)
  PROMPT=$(cat "$P")
  MCP=$(mcp_json_inline copilot)
  copilot -p "$PROMPT" \
    --allow-all-tools --allow-all-paths --allow-all-urls \
    --additional-mcp-config "$MCP" \
    >"$LOG_DIR/copilot.log" 2>&1 &
  start_pid copilot $!
fi

echo "[$RUN_ID] all agents launched. Sleeping $DURATION_S s. Audit: $MURMUR_AUDIT"

END=$(( $(date +%s) + DURATION_S ))
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 30
  if [ -f "$MURMUR_AUDIT" ]; then
    POLLS=$(grep -c '"tool":"poll"' "$MURMUR_AUDIT" 2>/dev/null | tr -d '\n' || echo 0)
    SAYS=$(grep -c '"tool":"say"' "$MURMUR_AUDIT" 2>/dev/null | tr -d '\n' || echo 0)
    REGS=$(grep -c '"tool":"register"' "$MURMUR_AUDIT" 2>/dev/null | tr -d '\n' || echo 0)
    REM=$(( END - $(date +%s) ))
    echo "[$RUN_ID] +$(( DURATION_S - REM ))s: regs=$REGS polls=$POLLS says=$SAYS remaining=${REM}s"
  fi
done

echo "[$RUN_ID] injecting STOP TEST..."
node "$ROOT/controller/inject_stop.mjs" "$MURMUR_DB"

# Give well-behaved agents up to 60s to see STOP and exit.
sleep 60

echo "[$RUN_ID] killing any survivors..."
for pidfile in "$LOG_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 2

echo "[$RUN_ID] generating report..."
node "$ROOT/controller/report.mjs" "$RUN_DIR" | tee "$RUN_DIR/report.md"
echo
echo "Run dir: $RUN_DIR"
