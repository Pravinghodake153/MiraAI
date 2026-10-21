#!/bin/bash
# ==============================================================================
# VivaAI Server Launcher (Automatic Bun Engine with Node.js Fallback)
# ==============================================================================

# 1. Resolve Script Directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 2. Add Bun and standard binary paths to PATH
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "======================================================"
echo "  Starting VivaAI Technical Examination Engine...     "
echo "======================================================"

# Free port 3000 if previously occupied
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[Port 3000] Clearing previous process..."
  kill -9 $(lsof -ti:3000) 2>/dev/null
  sleep 0.5
fi

# 3. Detect Runtime Engine (Bun preferred for SQLite & speed)
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
else
  BUN_BIN=""
fi

if [ -n "$BUN_BIN" ]; then
  echo "[Runtime] Using Bun ($("$BUN_BIN" --version))"
  echo "[Database] Bun Native SQLite + WAL Mode"
  exec "$BUN_BIN" server.js
else
  echo "[Warning] Bun not found in PATH, using Node.js fallback..."
  echo "[Runtime] Using Node ($(node -v))"
  exec node server.js
fi
