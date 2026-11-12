#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
ENVFILE=${PAWLINE_ENV_FILE:-.env}
export PAWLINE_ENV_FILE="$ENVFILE"
dc() { scripts/docker compose --env-file "$ENVFILE" "$@"; }
case "${1:-start}" in
  start)
    if ! scripts/docker info >/dev/null 2>&1; then
      echo 'Docker is unavailable. Start the demo with sh scripts/demo.sh first.' >&2
      exit 1
    fi
    if [ -z "$(dc ps --status running -q db)" ]; then
      echo 'The database is stopped. Start the demo with sh scripts/demo.sh first.' >&2
      exit 1
    fi
    # Match the running store image; opening the viewer never upgrades the shop.
    WEB_ID=$(dc ps --status running -q web)
    if [ -n "$WEB_ID" ]; then
      PAWLINE_DATABASE_UI_IMAGE=$(scripts/docker inspect --format '{{.Image}}' "$WEB_ID")
      export PAWLINE_DATABASE_UI_IMAGE
    fi
    dc up -d --no-deps --no-build --pull never --wait --wait-timeout 60 db-ui
    UI_PORT=${DATABASE_UI_PORT:-$(sed -n 's/^DATABASE_UI_PORT=//p' "$ENVFILE")}
    printf '\nDatabase interface: http://127.0.0.1:%s\nRuns in the background. Stop with: sh scripts/database-ui.sh stop\n' "${UI_PORT:-5555}"
    ;;
  stop) dc stop db-ui ;;
  status) dc ps -a db-ui ;;
  *) echo 'Usage: sh scripts/database-ui.sh [start|stop|status]' >&2; exit 2 ;;
esac
