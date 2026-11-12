#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "${1:-}" = 1 ] || { echo 'Refused: run make reset-demo CONFIRM=1 to reset the selected local demo.' >&2; exit 1; }
ENVFILE=${PAWLINE_ENV_FILE:-.env}
PROJECT=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ENVFILE")
case "$PROJECT" in
 pawline_demo) ;;
 pawline_verify_*_demo) [ "$(sed -n 's/^ALLOW_TEST_FAULTS=//p' "$ENVFILE")" = 1 ] && [ "$(sed -n 's/^DATA_SOURCE=//p' "$ENVFILE")" = test ] || exit 1;;
 *) echo 'Refused: target is not an explicitly designated demo instance.' >&2; exit 1;;
esac
ORIGIN=$(sed -n 's/^APP_PUBLIC_ORIGIN=//p' "$ENVFILE")
case "$ORIGIN" in http://127.0.0.1:*) ;; *) echo 'Refused: origin is not loopback.' >&2; exit 1;; esac
export PAWLINE_ENV_FILE="$ENVFILE"
dc(){ scripts/docker compose --env-file "$ENVFILE" -p "$PROJECT" "$@"; }
for suffix in database media mail; do
 VOLUME="${PROJECT}_${suffix}"
 LABEL=$(scripts/docker volume inspect --format '{{ index .Labels "com.pawline.project" }}' "$VOLUME" 2>/dev/null || true)
 [ "$LABEL" = "$PROJECT" ] || { echo "Refused: unexpected label for $VOLUME" >&2; exit 1; }
done
dc --profile database-tools down
scripts/docker volume rm "${PROJECT}_database" "${PROJECT}_media" "${PROJECT}_mail"
dc up -d --no-build --pull never --wait --wait-timeout 120 web worker mailpit
sh scripts/database-ui.sh
printf 'Reset only %s. Open %s\n' "$PROJECT" "$ORIGIN"
