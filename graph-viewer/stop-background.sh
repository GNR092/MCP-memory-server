#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PID_FILE="$SCRIPT_DIR/.graph-viewer.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No se encontro PID file. La app parece no estar corriendo."
  exit 0
fi

PID=$(cat "$PID_FILE")

if [ -z "$PID" ]; then
  echo "PID vacio. Limpiando archivo..."
  rm -f "$PID_FILE"
  exit 1
fi

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Deteniendo Graph Viewer (PID $PID)..."
else
  echo "El proceso $PID no estaba activo."
fi

rm -f "$PID_FILE"
echo "Graph Viewer detenido."
