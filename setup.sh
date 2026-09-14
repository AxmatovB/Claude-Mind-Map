#!/usr/bin/env bash
# Auto-generates .env for this machine — detects which of Claude Code,
# Codex CLI, and Gemini CLI are actually installed (by checking for their
# config directories under $HOME) and writes only those into .env. Safe to
# re-run any time; it overwrites .env with a fresh detection.
#
# For native Windows without Git Bash/WSL, use setup.ps1 instead.
set -euo pipefail

HOME_DIR="${HOME:-$USERPROFILE}"
if [ -z "$HOME_DIR" ]; then
  echo "Could not determine your home directory (\$HOME is unset)." >&2
  exit 1
fi

ENV_FILE="$(dirname "$0")/.env"
found_any=false
lines=()

to_docker_path() {
  # Git Bash / MSYS give us POSIX-style paths (/c/Users/you/.claude), but
  # Docker Desktop on Windows expects drive-letter paths (C:/Users/you/.claude)
  # in bind-mount sources read from a file (unlike interactive `docker run
  # -v`, there's no shell-level auto-conversion for values baked into .env).
  # cygpath -m gives exactly that format when it's available (Git for
  # Windows ships it); everywhere else (real Linux/Mac), the path is
  # already correct as-is.
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

check_agent() {
  local name="$1" dir="$2" var="$3"
  if [ -d "$dir" ]; then
    local docker_path
    docker_path="$(to_docker_path "$dir")"
    echo "  found $name -> $docker_path"
    lines+=("$var=$docker_path")
    found_any=true
  else
    echo "  $name not found (looked for $dir) — skipping"
  fi
}

echo "Detecting installed AI CLI agents under $HOME_DIR ..."
check_agent "Claude Code" "$HOME_DIR/.claude" "CLAUDE_HOME_DIR"
check_agent "Codex CLI"   "$HOME_DIR/.codex"  "CODEX_HOME_DIR"
check_agent "Gemini CLI"  "$HOME_DIR/.gemini" "GEMINI_HOME_DIR"

if [ "$found_any" = false ]; then
  echo
  echo "No agent config directories found. Claude Brain will still start (with" >&2
  echo "nothing to show) — install and use one of Claude Code / Codex CLI /" >&2
  echo "Gemini CLI at least once, then re-run this script." >&2
fi

printf '%s\n' "${lines[@]}" > "$ENV_FILE"
echo
echo "Wrote $ENV_FILE:"
cat "$ENV_FILE"
echo
echo "Next: docker compose up -d --build"
