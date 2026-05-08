#!/usr/bin/env bash
# Tier D regression: run the harness pointed at the v1 daemon
# (src/daemon/murmurd.mjs) instead of server/http_stub.mjs.
#
# Patches vs run_http.sh, applied via sed to a tmp script
# (run_http.sh stays untouched):
#   1. swap the daemon script path
#   2. export MURMUR_HOME=$RUN_DIR so v1 daemon's pid/port files land
#      in the run dir (not ~/.murmur), avoiding any conflict with a
#      real running daemon.
#   3. drop the broken `--additional-mcp-config` copilot flag (silently
#      ignored by copilot 1.0.43). We pre-position the persistent
#      ~/.copilot/mcp-config.json instead, and restore the user's
#      original on exit.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Pre-position persistent copilot MCP config so copilot can find murmur.
COPILOT_CFG="$HOME/.copilot/mcp-config.json"
COPILOT_BAK="$COPILOT_CFG.murmur-test-bak.$$"
mkdir -p "$(dirname "$COPILOT_CFG")"
if [ -f "$COPILOT_CFG" ]; then
  cp -p "$COPILOT_CFG" "$COPILOT_BAK"
fi
# We can't read the daemon URL until the harness picks the port, so use
# the harness default 9999 (matches what the original $URL_BASE resolves to).
cat >"$COPILOT_CFG" <<'EOF'
{
  "mcpServers": {
    "murmur": {
      "type": "http",
      "url": "http://localhost:9999/mcp/copilot",
      "tools": ["*"]
    }
  }
}
EOF

restore_copilot_cfg() {
  if [ -f "$COPILOT_BAK" ]; then
    mv -f "$COPILOT_BAK" "$COPILOT_CFG"
  else
    rm -f "$COPILOT_CFG"
  fi
}

TMP_SCRIPT=$(mktemp -t run_v1.XXXXXX.sh)
cleanup() {
  restore_copilot_cfg
  rm -f "$TMP_SCRIPT" "$ROOT_DIR/controller/run_http_patched.sh"
}
trap cleanup EXIT

sed \
  -e 's|\$ROOT/server/http_stub.mjs|$ROOT/src/daemon/murmurd.mjs|g' \
  -e 's|^RUN_DIR="\$ROOT/runs/\$RUN_ID"$|RUN_DIR="$ROOT/runs/$RUN_ID"\nexport MURMUR_HOME="$RUN_DIR"|' \
  -e '/--additional-mcp-config "\$MCP" \\/d' \
  "$ROOT_DIR/controller/run_http.sh" > "$TMP_SCRIPT"
chmod +x "$TMP_SCRIPT"
# Run from $ROOT_DIR so the patched script's `cd "$(dirname "$0")/.."`
# resolves to the murmur repo root.
cd "$ROOT_DIR/controller"
ln -sf "$TMP_SCRIPT" "$ROOT_DIR/controller/run_http_patched.sh"
# Run as subprocess (not exec) so the EXIT trap still fires for cleanup.
bash "$ROOT_DIR/controller/run_http_patched.sh" "$@"
