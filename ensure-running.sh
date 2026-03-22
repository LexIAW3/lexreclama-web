#!/usr/bin/env bash
# Ensures the web, OCR and LexPanel services are running. Safe to run from cron.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_PORT=8080
WEB_BASE_URL="http://127.0.0.1:$WEB_PORT"
OCR_PORT=3200
OCR_BASE_URL="http://127.0.0.1:$OCR_PORT"
LOG_FILE="/tmp/lexreclama-watchdog.log"

# Load optional secrets from .env (BREVO_API_KEY etc.)
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

log() {
  echo "[$(date)] $*" >> "$LOG_FILE"
}

is_expected_web_server() {
  local header
  header="$(curl -sSI --max-time 2 "$WEB_BASE_URL/" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-content-type-options"{print tolower($2)}')"
  [[ "$header" == "nosniff" ]]
}

# Returns true (exit 0) if the running web server is serving stale code:
# i.e. server.js was modified AFTER the server process started.
web_server_is_stale() {
  local server_js="$SCRIPT_DIR/server.js"
  local pid
  pid="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ -z "$pid" ]] && return 1  # not running — not "stale", just down

  local proc_start
  proc_start="$(stat -c %Y /proc/"$pid" 2>/dev/null || true)"
  [[ -z "$proc_start" ]] && return 1  # can't determine start time

  local file_mtime
  file_mtime="$(stat -c %Y "$server_js" 2>/dev/null || true)"
  [[ -z "$file_mtime" ]] && return 1  # can't determine file mtime

  # Stale if server.js is newer than the process start (with 5 s tolerance)
  (( file_mtime > proc_start + 5 ))
}

is_expected_ocr_server() {
  local body
  body="$(curl -s --max-time 2 "$OCR_BASE_URL/health" || true)"
  [[ "$body" == *'"ok":true'* ]]
}

free_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
    sleep 1
    local still_up
    still_up="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$still_up" ]]; then
      kill -9 $still_up 2>/dev/null || true
    fi
  fi
}

restart_web_server() {
  local port_responds=0
  if curl -s --max-time 2 "$WEB_BASE_URL/" > /dev/null 2>&1; then
    port_responds=1
    log "Unexpected process detected on :$WEB_PORT (responds but is not web/server.js). Replacing it."
  else
    log "Web server down on :$WEB_PORT. Restarting."
  fi

  free_port "$WEB_PORT"

  if ! is_expected_web_server && curl -s --max-time 2 "$WEB_BASE_URL/" > /dev/null 2>&1; then
    log "Port :$WEB_PORT is still occupied by an unexpected process after kill attempt. Manual root intervention required."
    return 1
  fi

  PAPERCLIP_API_URL=http://127.0.0.1:3100 \
  PAPERCLIP_COMPANY_ID=624b9ad4-76e3-4a63-91a4-29d4b646fca9 \
  PAPERCLIP_SUBMIT_KEY=***REMOVED*** \
  ADMIN_USER=admin \
  ADMIN_PASSWORD=***REMOVED*** \
  GA4_MEASUREMENT_ID=G-FFLXTDCJM5 \
  BREVO_API_KEY="${BREVO_API_KEY:-}" \
  BREVO_LIST_ID="${BREVO_LIST_ID:-3}" \
  PORT="$WEB_PORT" \
  nohup node /home/paperclip/despacho/web/server.js >> /tmp/web-server.log 2>&1 &

  local new_pid=$!
  sleep 1

  if is_expected_web_server; then
    log "Web server restarted successfully (PID $new_pid)."
    return 0
  fi

  log "Restart attempted (PID $new_pid) but web health check failed."
  return 1
}

restart_ocr_server() {
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    log "OCR server down on :$OCR_PORT but ANTHROPIC_API_KEY is missing; cannot restart automatically."
    return 1
  fi

  if curl -s --max-time 2 "$OCR_BASE_URL/health" > /dev/null 2>&1; then
    log "Unexpected process detected on :$OCR_PORT. Replacing it."
  else
    log "OCR server down on :$OCR_PORT. Restarting."
  fi

  free_port "$OCR_PORT"

  PAPERCLIP_API_URL=http://127.0.0.1:3100 \
  PAPERCLIP_COMPANY_ID=624b9ad4-76e3-4a63-91a4-29d4b646fca9 \
  PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:-***REMOVED***}" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  PORT="$OCR_PORT" \
  nohup /home/paperclip/despacho/ocr-server/start.sh >> /tmp/ocr-server.log 2>&1 &

  local new_pid=$!
  sleep 1

  if is_expected_ocr_server; then
    log "OCR server restarted successfully (PID $new_pid)."
    return 0
  fi

  log "Restart attempted (PID $new_pid) but OCR health check failed."
  return 1
}

status=0

if ! is_expected_web_server; then
  restart_web_server || status=1
elif web_server_is_stale; then
  log "Web server is stale (server.js modified after process start). Restarting to apply new code."
  restart_web_server || status=1
fi

if ! is_expected_ocr_server; then
  restart_ocr_server || status=1
fi

/home/paperclip/despacho/lexpanel/ensure-lexpanel.sh || status=1

exit "$status"
