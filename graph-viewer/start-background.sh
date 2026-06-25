#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PID_FILE="$SCRIPT_DIR/.graph-viewer.pid"
LOG_FILE="$SCRIPT_DIR/graph-viewer.log"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Graph Viewer ya esta corriendo con PID $PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

nohup node "$SCRIPT_DIR/server.js" > "$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"

echo "Graph Viewer iniciado en segundo plano"
echo "PID: $PID"
echo "Log: $LOG_FILE"
