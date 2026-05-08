#!/usr/bin/env bash
# Same as run.sh but all agents connect to a single shared http_stub server
# over Streamable HTTP MCP. Tests long-running session stability of the
# shared-server v1 architecture.
#
# Env:
#   DURATION_S  total run length in seconds (default 1800)
#   AGENTS      comma-separated subset of: claude,codex,gemini,cursor,copilot
#   PORT        http_stub port (default 9999)

set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

DURATION_S=${DURATION_S:-1800}
AGENTS=${AGENTS:-claude,codex,gemini,cursor,copilot}
MODE=${MURMUR_TEST_MODE:-always-empty}
PORT=${PORT:-9999}

RUN_ID=$(date -u +%Y-%m-%dT%H-%M-%SZ)_http
RUN_DIR="$ROOT/runs/$RUN_ID"
LOG_DIR="$RUN_DIR/logs"
PROMPT_DIR="$RUN_DIR/prompts"
mkdir -p "$LOG_DIR" "$PROMPT_DIR"

# Token-guard inject_stop so other agent sessions on this machine can't
# accidentally (or via prompt-injection) terminate this regression run.
HARNESS_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
umask 077
printf '%s' "$HARNESS_TOKEN" > "$RUN_DIR/.harness_token"
umask 022

export MURMUR_DB="$RUN_DIR/db.sqlite"
export MURMUR_AUDIT="$RUN_DIR/audit.jsonl"
export MURMUR_TEST_MODE="$MODE"

# Pre-create the DB schema (cheap reuse of stdio stub for table creation).
( node "$ROOT/server/stub.mjs" --label=_init </dev/null >/dev/null 2>&1 & sleep 0.3; kill $! 2>/dev/null; wait $! 2>/dev/null ) || true

# ---- Start the shared HTTP stub ----
# Refuse to start if the port is already bound (avoids the agents talking to
# a stale stub from a prior run).
if lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[$RUN_ID] ERROR: port $PORT already in use (pid $(lsof -i ":$PORT" -sTCP:LISTEN -t)). Kill it and retry." >&2
  exit 1
fi
echo "[$RUN_ID] starting http_stub on :$PORT"
node "$ROOT/server/http_stub.mjs" --port="$PORT" \
  >"$LOG_DIR/_http_stub.log" 2>&1 &
HTTP_PID=$!
echo "$HTTP_PID" > "$LOG_DIR/_http_stub.pid"
# Wait for listen.
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null -X POST -H 'content-type: application/json' \
       -H 'accept: application/json, text/event-stream' \
       --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
       "http://localhost:$PORT/mcp/_probe" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
sleep 0.5  # let any crash fully reap before kill -0
if ! kill -0 "$HTTP_PID" 2>/dev/null; then
  echo "[$RUN_ID] http_stub failed to start"; cat "$LOG_DIR/_http_stub.log"; exit 1
fi
# Verify the bound socket really belongs to OUR pid.
HOLDER=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ "$HOLDER" != "$HTTP_PID" ]; then
  echo "[$RUN_ID] ERROR: port $PORT held by pid $HOLDER, not our stub pid $HTTP_PID"; exit 1
fi
echo "[$RUN_ID] http_stub pid=$HTTP_PID (verified holding port $PORT)"

# ---- Side watcher: log every process holding the DB file ----
bash "$ROOT/controller/watch_db.sh" "$MURMUR_DB" "$LOG_DIR/_db_watch.log" &
WATCH_PID=$!
echo "$WATCH_PID" > "$LOG_DIR/_db_watch.pid"

write_prompt() {
  local handle=$1 agent=$2
  local out="$PROMPT_DIR/$handle.md"
  sed -e "s|<HANDLE>|$handle|g" -e "s|<AGENT>|$agent|g" "${PROMPT_FILE:-$ROOT/controller/prompt.md}" > "$out"
  echo "$out"
}

enabled() { [[ ",$AGENTS," == *",$1,"* ]]; }

start_pid() {
  local label=$1 pid=$2
  echo "$pid" > "$LOG_DIR/$label.pid"
  echo "[$RUN_ID] $label started pid=$pid" | tee -a "$LOG_DIR/_controller.log"
}

URL_BASE="http://localhost:$PORT/mcp"

# ---- Claude (HTTP) ----
if enabled claude; then
  P=$(write_prompt claude_bot claude-code)
  PROMPT=$(cat "$P")
  MCP=$(printf '{"mcpServers":{"murmur":{"type":"http","url":"%s/claude"}}}' "$URL_BASE")
  claude -p "$PROMPT" \
    --mcp-config "$MCP" \
    --dangerously-skip-permissions \
    --output-format text \
    >"$LOG_DIR/claude.log" 2>&1 &
  start_pid claude $!
fi

# ---- Codex (HTTP via ~/.codex/config.toml) ----
# Codex 0.44 ignores -c overrides for mcp_servers.<n>.url; it must be in
# config.toml, which the user has already configured to point at /mcp/codex
# on this port with experimental_use_rmcp_client = true. We do NOT modify it.
if enabled codex; then
  if ! grep -q "experimental_use_rmcp_client" ~/.codex/config.toml 2>/dev/null; then
    echo "[$RUN_ID] WARN: codex config missing experimental_use_rmcp_client; skipping" | tee -a "$LOG_DIR/_controller.log"
  elif ! grep -q "localhost:$PORT/mcp/codex" ~/.codex/config.toml 2>/dev/null; then
    echo "[$RUN_ID] WARN: codex config does not point at port $PORT; skipping" | tee -a "$LOG_DIR/_controller.log"
  else
    P=$(write_prompt codex_bot codex-cli)
    PROMPT=$(cat "$P")
    codex exec --full-auto --skip-git-repo-check \
      "$PROMPT" \
      >"$LOG_DIR/codex.log" 2>&1 &
    start_pid codex $!
  fi
fi

# ---- Gemini (HTTP) ----
if enabled gemini; then
  mkdir -p "$ROOT/.gemini"
  cat > "$ROOT/.gemini/settings.json" <<JSON
{
  "mcpServers": {
    "murmur": {
      "httpUrl": "$URL_BASE/gemini",
      "trust": true
    }
  }
}
JSON
  P=$(write_prompt gemini_bot gemini-cli)
  PROMPT=$(cat "$P")
  GEMINI_CLI_TRUST_WORKSPACE=true gemini -p "$PROMPT" --yolo \
    >"$LOG_DIR/gemini.log" 2>&1 &
  start_pid gemini $!
fi

# ---- Cursor (HTTP) ----
if enabled cursor; then
  mkdir -p "$ROOT/.cursor"
  cat > "$ROOT/.cursor/mcp.json" <<JSON
{"mcpServers":{"murmur":{"url":"$URL_BASE/cursor"}}}
JSON
  P=$(write_prompt cursor_bot cursor-agent)
  PROMPT=$(cat "$P")
  cursor-agent -p "$PROMPT" --force --approve-mcps --output-format text \
    >"$LOG_DIR/cursor.log" 2>&1 &
  start_pid cursor $!
fi

# ---- Copilot (HTTP) ----
if enabled copilot; then
  P=$(write_prompt copilot_bot copilot-cli)
  PROMPT=$(cat "$P")
  MCP=$(printf '{"mcpServers":{"murmur":{"type":"http","url":"%s/copilot"}}}' "$URL_BASE")
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
    SESS=$(grep -c '"tool":"_session_init"' "$MURMUR_AUDIT" 2>/dev/null | tr -d '\n' || echo 0)
    REM=$(( END - $(date +%s) ))
    HTTP_ALIVE=no
    if kill -0 "$HTTP_PID" 2>/dev/null; then HTTP_ALIVE=yes; fi
    echo "[$RUN_ID] +$(( DURATION_S - REM ))s: sessions=$SESS regs=$REGS polls=$POLLS says=$SAYS http=$HTTP_ALIVE remaining=${REM}s" \
      | tee -a "$LOG_DIR/_controller.log"
  fi
done

echo "[$RUN_ID] injecting STOP TEST..."
node "$ROOT/controller/inject_stop.mjs" "$MURMUR_DB" "--token=$HARNESS_TOKEN"

# Give agents up to 60s to see STOP and exit gracefully.
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

# Stop the watcher and HTTP stub last so we capture all final tool calls.
if [ -n "${WATCH_PID:-}" ] && kill -0 "$WATCH_PID" 2>/dev/null; then
  kill "$WATCH_PID" 2>/dev/null || true
fi
if kill -0 "$HTTP_PID" 2>/dev/null; then
  kill "$HTTP_PID" 2>/dev/null || true
fi

echo "[$RUN_ID] generating report..."
node "$ROOT/controller/report.mjs" "$RUN_DIR" | tee "$RUN_DIR/report.md"
echo
echo "Run dir: $RUN_DIR"
