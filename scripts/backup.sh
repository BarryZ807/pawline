#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
ENVFILE=${PAWLINE_ENV_FILE:-.env}
PROJECT=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ENVFILE")
ORIGIN=$(sed -n 's/^APP_PUBLIC_ORIGIN=//p' "$ENVFILE")
case "$PROJECT:$ORIGIN" in pawline_*:http://127.0.0.1:*) ;; *) echo 'Refusing backup: select a labelled local Pawline instance.' >&2; exit 1;; esac
export PAWLINE_ENV_FILE="$ENVFILE"
dc(){ scripts/docker compose --env-file "$ENVFILE" -p "$PROJECT" "$@"; }
DBUSER=$(sed -n 's/^POSTGRES_USER=//p' "$ENVFILE")
DBNAME=$(sed -n 's/^POSTGRES_DB=//p' "$ENVFILE")
DEST=".local/backups/${PROJECT}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$DEST"
for v in database media mail; do
 label=$(scripts/docker volume inspect "${PROJECT}_${v}" --format '{{index .Labels "com.pawline.project"}}')
 [ "$label" = "$PROJECT" ] || { echo 'Volume label mismatch; refusing backup.' >&2; exit 1; }
done
RUNNING_SERVICES=$(dc ps --status running --services web worker mailpit db-ui)
WEB_ID=$(dc ps --status running -q web)
[ -n "$WEB_ID" ] || { echo 'Start the store before taking a full-stack backup.' >&2; exit 1; }
WEB_IMAGE=$(scripts/docker inspect "$WEB_ID" --format '{{.Image}}')
restore_service(){ dc exec -T db psql -U "$DBUSER" -d "$DBNAME" -c 'UPDATE "Setting" SET value='"'false'"'::jsonb WHERE key='"'maintenance'"';' >/dev/null; if [ -n "$RUNNING_SERVICES" ]; then dc start $RUNNING_SERVICES >/dev/null; fi; }
trap restore_service EXIT HUP INT TERM
dc exec -T db psql -U "$DBUSER" -d "$DBNAME" -c 'UPDATE "Setting" SET value='"'true'"'::jsonb WHERE key='"'maintenance'"';' >/dev/null
dc stop -t 35 web worker mailpit db-ui >/dev/null
dc exec -T db pg_dump -U "$DBUSER" -d "$DBNAME" --format=custom > "$DEST/database.dump"
scripts/docker run --rm --network none -v "${PROJECT}_media:/media:ro" "$WEB_IMAGE" node scripts/media-manifest.mjs > "$DEST/media-manifest.json"
for v in media mail; do scripts/docker run --rm --network none --user root -v "${PROJECT}_${v}:/snapshot:ro" "$WEB_IMAGE" tar -C /snapshot -czf - . > "$DEST/$v.tar.gz"; done
cp "$ENVFILE" "$DEST/private-env"
printf '%s\n' "$WEB_IMAGE" > "$DEST/image.txt"
shasum -a 256 "$DEST/database.dump" "$DEST/media.tar.gz" "$DEST/mail.tar.gz" > "$DEST/sha256.txt"
printf '%s\n' "$DEST" > .local/latest-backup
printf '%s\n' "$DEST" > ".local/latest-backup-$PROJECT"
if [ "$ENVFILE" = .env ]; then printf '%s\n' "$DEST" > .local/latest-main-backup; fi
printf 'Consistent local snapshot: %s\nPrivate credentials are stored separately in private-env (mode 600).\n' "$DEST"
