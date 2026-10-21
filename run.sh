#!/usr/bin/env bash
# ==============================================================================
# VivaAI Production Platform Runner (run.sh)
# Clears occupied ports, validates runtime, and starts server on port 8080
# ==============================================================================

set -e

# 1. Resolve Script & Application Directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/VivaAi_app"

if [ -f "$SCRIPT_DIR/server.js" ]; then
  TARGET_DIR="$SCRIPT_DIR"
elif [ -d "$APP_DIR" ] && [ -f "$APP_DIR/server.js" ]; then
  TARGET_DIR="$APP_DIR"
else
  echo "[Error] Could not locate server.js in $SCRIPT_DIR or $APP_DIR"
  exit 1
fi

cd "$TARGET_DIR"

# 2. Add Bun and standard executable paths to PATH
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PORT="${PORT:-8080}"

echo "======================================================"
echo "  Starting VivaAI Production Examination Engine       "
echo "  Port: $PORT                                         "
echo "  Directory: $TARGET_DIR                              "
echo "======================================================"

# 3. Clean up any hanging processes on Port 8080 or Port 8081
for P in "$PORT" 8081 3000; do
  if lsof -Pi :"$P" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "[Port $P] Freeing up previously occupied process..."
    kill -9 $(lsof -ti:"$P") 2>/dev/null || true
    sleep 0.4
  fi
done

# 4. Detect Runtime (Prefers Bun for native SQLite WAL engine; Node.js fallback)
BUN_BIN=""
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
fi

if [ -n "$BUN_BIN" ]; then
  echo "[Runtime] Using Bun ($("$BUN_BIN" --version))"
  echo "[Database] Bun Native SQLite + WAL Mode (data/viva.sqlite)"
  echo "[Access] http://localhost:$PORT"
  echo "======================================================"
  exec "$BUN_BIN" server.js
else
  echo "[Warning] Bun not found in PATH, using Node.js..."
  echo "[Runtime] Using Node ($(node -v))"
  echo "[Access] http://localhost:$PORT"
  echo "======================================================"
  exec node server.js
fi
