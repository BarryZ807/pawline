#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
ENVFILE=${PAWLINE_ENV_FILE:-.env}
[ -f "$ENVFILE" ] || { echo 'Run sh scripts/start.sh first.' >&2; exit 1; }
export PAWLINE_ENV_FILE="$ENVFILE"
DBUSER=$(sed -n 's/^POSTGRES_USER=//p' "$ENVFILE")
DBNAME=$(sed -n 's/^POSTGRES_DB=//p' "$ENVFILE")
DBPORT=$(sed -n 's/^DATABASE_UI_PORT=//p' "$ENVFILE")
dc(){ scripts/docker compose --env-file "$ENVFILE" "$@"; }
case "${1:-status}" in
  status)
    dc ps -a db db-ui web worker mailpit
    dc exec -T db psql -U "$DBUSER" -d "$DBNAME" -c 'SELECT current_database() AS database, current_schema() AS schema, current_setting('\''server_version'\'') AS postgres_version;'
    printf 'Database interface: http://127.0.0.1:%s\nRun sh scripts/database-ui.sh if it is stopped.\n' "${DBPORT:-5555}"
    ;;
  counts) dc exec -T db psql -X -U "$DBUSER" -d "$DBNAME" -v ON_ERROR_STOP=1 -f - < docs/sql/database-overview.sql ;;
  trace)
    REFERENCE=${2:-}
    case "$REFERENCE" in ''|*[!A-Z0-9-]*) echo 'Use the exact order reference, for example sh scripts/database.sh trace PL-0123456789' >&2; exit 1;; esac
    [ "${#REFERENCE}" -le 64 ] || { echo 'Order reference is too long.' >&2; exit 1; }
    dc exec -T db psql -X -U "$DBUSER" -d "$DBNAME" -v ON_ERROR_STOP=1 --set=order_ref="$REFERENCE" -f - < docs/sql/order-trace.sql
    ;;
  shell) dc exec db psql -X -U "$DBUSER" -d "$DBNAME" ;;
  *) echo 'Usage: sh scripts/database.sh [status|counts|trace ORDER_REFERENCE|shell]' >&2; exit 1 ;;
esac
