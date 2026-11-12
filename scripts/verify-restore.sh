#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
if [ -n "${BACKUP_DIR:-}" ]; then SNAPSHOT=$BACKUP_DIR; else sh scripts/backup.sh; SNAPSHOT=$(cat .local/latest-backup); fi
[ -f "$SNAPSHOT/database.dump" ] && [ -f "$SNAPSHOT/media.tar.gz" ] || { echo 'Snapshot is incomplete.' >&2; exit 1; }
PROJECT="pawline_restore_$(date +%s)_$$"
ENVFILE=".local/$PROJECT.env"
WEBPORT=${RESTORE_PORT:-3300}
MAILPORT=${RESTORE_MAIL_PORT:-8325}
DBUIPORT=${RESTORE_DATABASE_UI_PORT:-$((WEBPORT+2))}
sed -e "s/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=$PROJECT/" -e "s/^WEB_PORT=.*/WEB_PORT=$WEBPORT/" -e "s/^MAIL_PORT=.*/MAIL_PORT=$MAILPORT/" -e "s|^APP_PUBLIC_ORIGIN=.*|APP_PUBLIC_ORIGIN=http://127.0.0.1:$WEBPORT|" "$SNAPSHOT/private-env" > "$ENVFILE"
if [ -n "$(sed -n '/^DATABASE_UI_PORT=/p' "$ENVFILE")" ]; then
  sed "s/^DATABASE_UI_PORT=.*/DATABASE_UI_PORT=$DBUIPORT/" "$ENVFILE" > "$ENVFILE.tmp"
  mv "$ENVFILE.tmp" "$ENVFILE"
else
  printf '\nDATABASE_UI_PORT=%s\n' "$DBUIPORT" >> "$ENVFILE"
fi
export PAWLINE_ENV_FILE="$ENVFILE"
dc(){ scripts/docker compose --env-file "$ENVFILE" -p "$PROJECT" "$@"; }
DBUSER=$(sed -n 's/^POSTGRES_USER=//p' "$ENVFILE")
DBNAME=$(sed -n 's/^POSTGRES_DB=//p' "$ENVFILE")
dc up -d --no-build --pull never --wait db mailpit >/dev/null
dc stop mailpit >/dev/null
scripts/docker volume create --label "com.pawline.project=$PROJECT" "${PROJECT}_media" >/dev/null
for v in media mail; do cat "$SNAPSHOT/$v.tar.gz" | scripts/docker run --rm -i --network none --user root -v "${PROJECT}_${v}:/snapshot" pawline-local:1 tar -C /snapshot -xzf -; done
cat "$SNAPSHOT/database.dump" | dc exec -T db pg_restore -U "$DBUSER" -d "$DBNAME" --no-owner --exit-on-error
# Restore keeps maintenance=true until files and external receipts have been checked.
mkdir -p artifacts/qa/restore
dc run --rm --no-deps web npx tsx scripts/check-restored.ts > "artifacts/qa/restore/$PROJECT.json"
dc exec -T db psql -U "$DBUSER" -d "$DBNAME" -c 'UPDATE "Setting" SET value='"'false'"'::jsonb WHERE key='"'maintenance'"';' >/dev/null
dc up -d --no-build --pull never --wait --wait-timeout 120 web worker mailpit >/dev/null
printf 'Restore verified in isolated instance %s\nOpen http://127.0.0.1:%s\nOriginal demo volumes were not modified.\n' "$PROJECT" "$WEBPORT"
printf '%s\n' "$ENVFILE" > .local/latest-restore-env
