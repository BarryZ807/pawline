#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
ENVFILE=$1
CONTROL=$2
PROJECT=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ENVFILE")
case "$PROJECT" in pawline_verify_*) ;; *) echo 'Controller requires an isolated verify project.' >&2; exit 1;; esac
export PAWLINE_ENV_FILE=$ENVFILE
dc(){ scripts/docker compose -f compose.yaml -f compose.verify.yaml --env-file "$ENVFILE" -p "$PROJECT" "$@"; }
mkdir -p "$CONTROL"
while [ ! -f "$CONTROL/finish" ]; do
  for action in stop-worker start-worker stop-db start-db stop-mail start-mail; do
    if [ -f "$CONTROL/$action.request" ] && [ ! -f "$CONTROL/$action.done" ]; then
      case "$action" in
        stop-worker) dc stop -t 5 worker;; start-worker) dc start worker;;
        stop-db) dc stop -t 5 db;; start-db) dc start db;;
        stop-mail) dc stop -t 5 mailpit;; start-mail) dc start mailpit;;
      esac
      date -u +%Y-%m-%dT%H:%M:%SZ > "$CONTROL/$action.done"
    fi
  done
  sleep 1
done
