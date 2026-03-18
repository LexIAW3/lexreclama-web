#!/usr/bin/env bash
# Ensures the LexReclama Node server is running. Safe to run from cron.
set -euo pipefail

PORT=8080
BASE_URL="http://127.0.0.1:$PORT"
LOG_FILE="/tmp/lexreclama-watchdog.log"

log() {
  echo "[$(date)] $*" >> "$LOG_FILE"
}

is_expected_server() {
  local header
  header="$(curl -sSI --max-time 2 "$BASE_URL/" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-content-type-options"{print tolower($2)}')"
  [[ "$header" == "nosniff" ]]
}

if is_expected_server; then
  exit 0
fi

PORT_RESPONDS=0
if curl -s --max-time 2 "$BASE_URL/" > /dev/null 2>&1; then
  PORT_RESPONDS=1
  log "Unexpected process detected on :$PORT (responds but is not web/server.js). Replacing it."
else
  log "Web server down on :$PORT. Restarting."
fi

PIDS="$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  kill $PIDS 2>/dev/null || true
  sleep 1
  STILL_UP="$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$STILL_UP" ]]; then
    kill -9 $STILL_UP 2>/dev/null || true
  fi
else
  if [[ "$PORT_RESPONDS" -eq 1 ]]; then
    log "Cannot identify PID bound to :$PORT (likely privileged/root-owned listener). Manual root intervention required."
    exit 1
  fi
fi

if ! is_expected_server && curl -s --max-time 2 "$BASE_URL/" > /dev/null 2>&1; then
  log "Port :$PORT is still occupied by an unexpected process after kill attempt. Manual root intervention required."
  exit 1
fi

PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_COMPANY_ID=624b9ad4-76e3-4a63-91a4-29d4b646fca9 \
PAPERCLIP_SUBMIT_KEY=***REMOVED*** \
ADMIN_USER=admin \
ADMIN_PASSWORD=***REMOVED*** \
PORT=$PORT \
nohup node /home/paperclip/despacho/web/server.js >> /tmp/web-server.log 2>&1 &

NEW_PID=$!
sleep 1

if is_expected_server; then
  log "Web server restarted successfully (PID $NEW_PID)."
  exit 0
fi

log "Restart attempted (PID $NEW_PID) but health check failed."
exit 1
