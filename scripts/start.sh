#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if ! scripts/docker info >/dev/null 2>&1; then
  if [ -x .local/tools/colima ]; then scripts/docker engine-start; else
    echo 'Start Docker Desktop, wait for its engine, then run sh scripts/start.sh again.' >&2
    exit 1
  fi
fi
ENVFILE=${PAWLINE_ENV_FILE:-.env}
if [ ! -f "$ENVFILE" ]; then
  [ "$ENVFILE" = .env ] || { echo "Missing environment: $ENVFILE" >&2; exit 1; }
  if command -v node >/dev/null 2>&1; then node scripts/init-env.mjs; else
    scripts/docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace node:24.14.0-bookworm-slim node scripts/init-env.mjs
  fi
fi
export PAWLINE_ENV_FILE="$ENVFILE"
if [ "${OFFLINE:-0}" = 1 ]; then
  scripts/docker compose --env-file "$ENVFILE" up -d --no-build --pull never --wait --wait-timeout 120 web worker mailpit
else
  scripts/docker compose --env-file "$ENVFILE" up -d --build --wait --wait-timeout 180 web worker mailpit
fi
# Wait for the actual running store image, then start its matching database viewer.
sh scripts/database-ui.sh
ORIGIN=$(sed -n 's/^APP_PUBLIC_ORIGIN=//p' "$ENVFILE")
MAILPORT=$(sed -n 's/^MAIL_PORT=//p' "$ENVFILE")
DBPORT=$(sed -n 's/^DATABASE_UI_PORT=//p' "$ENVFILE")
printf '\nPawline full stack is ready.\nStore: %s\nOwner: %s/admin\nDesigner: %s/studio\nDatabase overview and order trace: %s/admin/database\nPostgreSQL interface: http://127.0.0.1:%s\nLocal inbox: http://127.0.0.1:%s\nGuide: %s/demo\nPrivate credentials: %s/.local/credentials.txt\nExisting data is retained. Use separate browser profiles for buyer, designer and owner.\n' "$ORIGIN" "$ORIGIN" "$ORIGIN" "$ORIGIN" "${DBPORT:-5555}" "${MAILPORT:-8025}" "$ORIGIN" "$PWD"
