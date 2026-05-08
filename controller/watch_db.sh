#!/usr/bin/env bash
# Periodically log every process holding an FD on the run's db.sqlite, so we
# can identify any unexpected writer.
DB=$1
OUT=$2
[ -z "$DB" ] && { echo "usage: watch_db.sh <db> <out>"; exit 2; }
while true; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
  HOLDERS=$(lsof "$DB" 2>/dev/null | tail -n +2 | awk '{print $1"/"$2}' | sort -u | tr '\n' ',' | sed 's/,$//')
  if [ -n "$HOLDERS" ]; then
    echo "$TS $HOLDERS" >> "$OUT"
  fi
  sleep 1
done
