#!/usr/bin/env bash
# Starts Claude Translate and opens it in the browser. Ctrl-C stops it.
set -euo pipefail

# The repo root: this script is scripts/start.sh.
APP_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
APP_URL="http://localhost:${PORT}"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null || fail "node not found. Install Node.js 24 or newer."
node_major_version="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major_version >= 24 )) || fail "Node.js ${node_major_version} is too old. Install Node.js 24 or newer."

command -v claude >/dev/null || fail "claude CLI not found. Install Claude Code first: https://code.claude.com/docs"

auth_method="$(claude auth status 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
    try {
      const status = JSON.parse(raw);
      console.log(status.loggedIn ? status.authMethod : "logged_out");
    } catch { console.log("unknown"); }
  });
')"
case "$auth_method" in
  claude.ai) ;;
  logged_out) fail "claude CLI is not logged in. Run: claude auth login" ;;
  *) fail "claude CLI must be logged in with a Claude subscription (got: ${auth_method}). Run: claude auth login" ;;
esac

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS "$APP_URL/" 2>/dev/null | grep -q '<title>Claude Translate</title>'; then
    echo "Claude Translate is already running: ${APP_URL}"
    open "$APP_URL"
    exit 0
  fi
  port_owner="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 " (pid " $2 ")" }')"
  fail "port ${PORT} is used by ${port_owner}. Pick another port: PORT=8788 npm start"
fi

(
  for _ in $(seq 1 50); do
    if curl -fsS -o /dev/null "$APP_URL/" 2>/dev/null; then
      open "$APP_URL"
      exit 0
    fi
    sleep 0.2
  done
) &

# Node runs the TypeScript directly; the server strips types from web/*.ts with node:module's stripTypeScriptTypes,
# which still prints an ExperimentalWarning once.
exec env PORT="$PORT" node --disable-warning=ExperimentalWarning "$APP_DIRECTORY/src/server.ts"
