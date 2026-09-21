#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${HOME}/.local/bin"
SKILLS="${HOME}/.claude/skills"

command -v node >/dev/null || { echo "bx: node is required"; exit 1; }

mkdir -p "$BIN" "$SKILLS" "${HOME}/.bx/shots"
ln -sf "$ROOT/cli/bx" "$BIN/bx"
ln -sfn "$ROOT/skill" "$SKILLS/bx"

node "$ROOT/bridge/server.js" >/dev/null 2>&1 &
sleep 0.6
kill %1 2>/dev/null || true   # first run just materialises ~/.bx/config.json

cat <<TXT

  bx installed

  cli     $BIN/bx        $(case ":$PATH:" in *":$BIN:"*) echo "(on PATH)";; *) echo "→ add $BIN to PATH";; esac)
  skill   $SKILLS/bx
  config  ${HOME}/.bx/config.json

  Load the extension — one time:
    1  chrome://extensions
    2  toggle Developer mode (top right)
    3  Load unpacked  →  $ROOT/extension

  Then:  bx status

  Optional, for the agent loop (on by default):
    bx jev key sk-...             # get a key: https://codiv.ai → API Console → Keys (README: "Get a jev key")
    bx agent "open the pricing page and screenshot it"

TXT
