#!/usr/bin/env bash
# Reactive mid-join test. Two stages:
#   Stage 1: launch claude_bot only with normal prompt. Inject 2 controller
#            messages so it speaks in the room.
#   Stage 2: at T=STAGE1_S, launch a "late joiner" with prompt that mandates
#            history() before polling. Then inject a controller message that
#            references stage-1 chat to verify the joiner has caught up.

set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

STAGE1_S=${STAGE1_S:-90}
STAGE2_S=${STAGE2_S:-180}
LATE_AGENT=${LATE_AGENT:-cursor}     # which CLI joins late
LATE_HANDLE=${LATE_HANDLE:-cursor_bot}

RUN_ID=$(date -u +%Y-%m-%dT%H-%M-%SZ)
RUN_DIR="$ROOT/runs/${RUN_ID}_reactive"
LOG_DIR="$RUN_DIR/logs"
PROMPT_DIR="$RUN_DIR/prompts"
mkdir -p "$LOG_DIR" "$PROMPT_DIR"

export MURMUR_DB="$RUN_DIR/db.sqlite"
export MURMUR_AUDIT="$RUN_DIR/audit.jsonl"
export MURMUR_TEST_MODE="always-empty"

echo "[$RUN_ID] reactive test: claude (early) + $LATE_AGENT (late at +${STAGE1_S}s)"

# Pre-create DB schema.
( node "$ROOT/server/stub.mjs" --label=_init </dev/null >/dev/null 2>&1 & sleep 0.3; kill $! 2>/dev/null; wait $! 2>/dev/null ) || true

write_prompt() {
  local handle=$1 agent=$2 src=$3
  local out="$PROMPT_DIR/$handle.md"
  sed -e "s|<HANDLE>|$handle|g" -e "s|<AGENT>|$agent|g" "$src" > "$out"
  cat "$out"
}

# ---- Stage 1: claude alone ----
P1=$(write_prompt claude_bot claude-code "$ROOT/controller/prompt.md")
MCP1=$(printf '{"mcpServers":{"murmur":{"command":"node","args":["%s/server/stub.mjs","--label=claude"],"env":{"MURMUR_DB":"%s","MURMUR_AUDIT":"%s","MURMUR_TEST_MODE":"%s"}}}}' \
  "$ROOT" "$MURMUR_DB" "$MURMUR_AUDIT" "$MURMUR_TEST_MODE")
claude -p "$P1" --mcp-config "$MCP1" --dangerously-skip-permissions --output-format text \
  >"$LOG_DIR/claude.log" 2>&1 &
CLAUDE_PID=$!
echo "[$RUN_ID] claude pid=$CLAUDE_PID"

# Inject two messages early in stage 1 so claude speaks.
sleep 15
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$MURMUR_DB');
const ins=db.prepare(\"INSERT INTO messages (sender, body, mentions, ts) VALUES ('controller',?,?,?)\");
const r1=ins.run('@claude_bot the secret password is BANANA42 — please remember it.', JSON.stringify(['claude_bot']), new Date().toISOString());
console.log('msg_'+r1.lastInsertRowid+' sent');
"
sleep 30
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$MURMUR_DB');
const ins=db.prepare(\"INSERT INTO messages (sender, body, mentions, ts) VALUES ('controller',?,?,?)\");
const r=ins.run('@claude_bot please confirm you remember the secret password by replying with just the word YES.', JSON.stringify(['claude_bot']), new Date().toISOString());
console.log('msg_'+r.lastInsertRowid+' sent');
"

# Wait until the end of stage 1 before launching late joiner.
NOW=$(date +%s); END_STAGE1=$(( NOW - 45 + STAGE1_S ))
while [ "$(date +%s)" -lt "$END_STAGE1" ]; do sleep 5; done

# ---- Stage 2: late joiner ----
echo "[$RUN_ID] launching late joiner: $LATE_AGENT as $LATE_HANDLE"
P2=$(write_prompt "$LATE_HANDLE" "$LATE_AGENT-cli" "$ROOT/controller/prompt_late_joiner.md")
MCP2=$(printf '{"mcpServers":{"murmur":{"command":"node","args":["%s/server/stub.mjs","--label=%s"],"env":{"MURMUR_DB":"%s","MURMUR_AUDIT":"%s","MURMUR_TEST_MODE":"%s"}}}}' \
  "$ROOT" "$LATE_AGENT" "$MURMUR_DB" "$MURMUR_AUDIT" "$MURMUR_TEST_MODE")

case "$LATE_AGENT" in
  cursor)
    mkdir -p "$ROOT/.cursor"
    cat > "$ROOT/.cursor/mcp.json" <<JSON
{"mcpServers":{"murmur":{"command":"node","args":["$ROOT/server/stub.mjs","--label=cursor"],"env":{"MURMUR_DB":"$MURMUR_DB","MURMUR_AUDIT":"$MURMUR_AUDIT","MURMUR_TEST_MODE":"$MURMUR_TEST_MODE"}}}}
JSON
    cursor-agent -p "$P2" --force --approve-mcps --output-format text \
      >"$LOG_DIR/cursor.log" 2>&1 &
    LATE_PID=$!
    ;;
  codex)
    codex exec --full-auto --skip-git-repo-check \
      -c "model=\"gpt-5\"" \
      -c "model_reasoning_effort=\"medium\"" \
      -c "mcp_servers.murmur.command=\"node\"" \
      -c "mcp_servers.murmur.args=[\"$ROOT/server/stub.mjs\",\"--label=codex\"]" \
      -c "mcp_servers.murmur.env={MURMUR_DB=\"$MURMUR_DB\",MURMUR_AUDIT=\"$MURMUR_AUDIT\",MURMUR_TEST_MODE=\"$MURMUR_TEST_MODE\"}" \
      "$P2" \
      >"$LOG_DIR/codex.log" 2>&1 &
    LATE_PID=$!
    ;;
  *)
    echo "unsupported LATE_AGENT=$LATE_AGENT"; exit 2;;
esac

echo "[$RUN_ID] late joiner pid=$LATE_PID"

# Inject a question to the late joiner that requires having read history.
sleep 25
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$MURMUR_DB');
const ins=db.prepare(\"INSERT INTO messages (sender, body, mentions, ts) VALUES ('controller',?,?,?)\");
const r=ins.run('@$LATE_HANDLE what password did claude_bot just confirm? Reply with just the word.', JSON.stringify(['$LATE_HANDLE']), new Date().toISOString());
console.log('probe msg_'+r.lastInsertRowid+' sent');
"

# Stage 2 wait then STOP TEST.
sleep $(( STAGE2_S - 25 ))
echo "[$RUN_ID] injecting STOP TEST..."
node "$ROOT/controller/inject_stop.mjs" "$MURMUR_DB"
sleep 30

# Kill stragglers.
for pid in "$CLAUDE_PID" "$LATE_PID"; do
  if kill -0 "$pid" 2>/dev/null; then pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; fi
done
sleep 2

echo "[$RUN_ID] generating polling report..."
node "$ROOT/controller/report.mjs" "$RUN_DIR" | tee "$RUN_DIR/report.md"

echo
echo "[$RUN_ID] reactive analysis:"
node -e "
const {readFileSync}=require('node:fs');
const evs=readFileSync('$MURMUR_AUDIT','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const hist=evs.filter(e=>e.tool==='history' && e.agent_label==='$LATE_AGENT');
const reg=evs.filter(e=>e.tool==='register' && e.agent_label==='$LATE_AGENT');
const polls=evs.filter(e=>e.tool==='poll' && e.agent_label==='$LATE_AGENT');
const says=evs.filter(e=>e.tool==='say' && e.agent_label==='$LATE_AGENT');
console.log('register count :', reg.length);
console.log('history calls  :', hist.length);
console.log('poll count     :', polls.length);
console.log('say count      :', says.length);
console.log('history-before-poll:', hist.length && polls.length ? Date.parse(hist[0].ts) < Date.parse(polls[0].ts) : false);
console.log('say bodies     :');
for (const s of says) console.log('   ', s.params.message);
" | tee "$RUN_DIR/reactive.md"

echo
echo "Run dir: $RUN_DIR"
