#!/usr/bin/env bash
# Wrapper around run.sh that injects @-mention messages mid-run
# to test responsiveness, not just polling-loop survival.
#
# Schedule: register window 45s, then one personal mention every
# MENTION_INTERVAL_S to each handle, then @all, then idle window
# for a couple more poll cycles, then STOP TEST.

set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

REGISTER_WINDOW_S=${REGISTER_WINDOW_S:-45}
MENTION_INTERVAL_S=${MENTION_INTERVAL_S:-45}
HANDLES=${HANDLES:-claude_bot,codex_bot,gemini_bot,cursor_bot,copilot_bot}
AGENTS=${AGENTS:-claude,codex,gemini,cursor,copilot}

# n personal + 1 @all + tail window
N_HANDLES=$(awk -F, '{print NF}' <<<"$HANDLES")
TAIL_S=${TAIL_S:-90}
DURATION_S=$(( REGISTER_WINDOW_S + (N_HANDLES + 1) * MENTION_INTERVAL_S + TAIL_S ))
export DURATION_S
export AGENTS

echo "[mentions] DURATION_S=$DURATION_S register=$REGISTER_WINDOW_S interval=$MENTION_INTERVAL_S tail=$TAIL_S"

# Launch the standard harness in background; it creates runs/<id>.
"$ROOT/controller/run.sh" &
HARNESS_PID=$!

# Find the run dir it just created (newest under runs/).
sleep 3
RUN_DIR=$(ls -1dt "$ROOT/runs"/2* 2>/dev/null | head -1)
if [ -z "$RUN_DIR" ]; then
  echo "[mentions] ERROR: could not find run dir"
  kill "$HARNESS_PID" 2>/dev/null
  exit 1
fi
echo "[mentions] run dir: $RUN_DIR"

# Wait for register window so all agents are in the room.
sleep "$REGISTER_WINDOW_S"

# Inject mentions on a schedule.
node "$ROOT/controller/inject_mentions.mjs" "$RUN_DIR/db.sqlite" "$HANDLES" "$MENTION_INTERVAL_S" \
  > "$RUN_DIR/logs/_mentions.log" 2>&1

# Let harness run to its DURATION_S, inject STOP TEST, and produce the
# polling report. Then we add the mention-response analysis.
wait "$HARNESS_PID"

echo
echo "[mentions] generating mention-response report..."
node "$ROOT/controller/analyze_mentions.mjs" "$RUN_DIR" | tee "$RUN_DIR/mentions.md"

echo
echo "Reports:"
echo "  $RUN_DIR/report.md       (polling survival)"
echo "  $RUN_DIR/mentions.md     (mention responses)"
