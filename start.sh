#!/usr/bin/env bash
# Start the despacho landing page server
# Requires: PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_SUBMIT_KEY, ADMIN_PASSWORD

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${PAPERCLIP_API_URL:=http://127.0.0.1:3100}"
: "${PAPERCLIP_COMPANY_ID:?PAPERCLIP_COMPANY_ID must be set}"
: "${PAPERCLIP_SUBMIT_KEY:?PAPERCLIP_SUBMIT_KEY must be set (CEO or manager API key)}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set (password for /admin Basic Auth)}"
: "${ADMIN_USER:=admin}"
: "${GA4_MEASUREMENT_ID:=}"  # optional - Google Analytics 4 Measurement ID (e.g. G-XXXXXXXXXX)

export PAPERCLIP_API_URL PAPERCLIP_COMPANY_ID PAPERCLIP_SUBMIT_KEY ADMIN_USER ADMIN_PASSWORD GA4_MEASUREMENT_ID

# Para activar GA4:
# 1. Crear propiedad en https://analytics.google.com
# 2. Copiar el Measurement ID (formato G-XXXXXXXXXX)
# 3. Arrancar el servidor con: GA4_MEASUREMENT_ID=G-XXXXXXXXXX ./start.sh

exec node "$SCRIPT_DIR/server.js"
