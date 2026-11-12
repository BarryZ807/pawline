#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
RUNID="$(date -u +%Y%m%d_%H%M%S)_$$"
BASEPORT=${VERIFY_PORT:-$((20000 + $$ % 15000))}
REPORT="artifacts/qa/verify_$RUNID"
mkdir -p "$REPORT" .local/test-results
chmod 700 .local .local/test-results
printf 'Isolated verification run: %s\n' "$RUNID"
if [ "${OFFLINE:-0}" != 1 ]; then
 scripts/docker compose build web > "$REPORT/build.log" 2>&1
 scripts/docker build -f Dockerfile.verify -t pawline-verify:2 . > "$REPORT/browser-build.log" 2>&1
else
 for img in pawline-local:1 pawline-verify:2 postgres:17.7-alpine axllent/mailpit:v1.33.0; do scripts/docker image inspect "$img" >/dev/null || { echo "Missing cached image: $img"; exit 1; }; done
fi
scripts/docker image inspect pawline-local:1 --format '{{.Id}}' > "$REPORT/image.txt"
scripts/docker info --format '{{.OSType}}/{{.Architecture}}' > "$REPORT/runtime-platform.txt"
scripts/docker info --format '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}' > "$REPORT/runtime-resources.json"
uname -sm > "$REPORT/host-platform.txt"
scripts/docker run --rm --network none -v "$PWD:/workspace" -w /workspace --entrypoint node pawline-local:1 scripts/source-manifest.mjs "$REPORT/source-manifest.json"
ENVFILE=''; PROJECT=''; CONTROL_PID=''; EXTRA=''
dc(){ scripts/docker compose -f compose.yaml -f compose.verify.yaml $EXTRA --env-file "$ENVFILE" -p "$PROJECT" "$@"; }
finish(){ code=$?; scripts/docker run --rm --network none -v "$PWD:/workspace" -w /workspace --entrypoint node pawline-local:1 scripts/sanitize-reports.mjs "$REPORT" >/dev/null 2>&1 || true; if [ -n "$CONTROL_PID" ]; then kill "$CONTROL_PID" 2>/dev/null || true; fi; if [ -n "$PROJECT" ]; then dc --profile database-tools down --remove-orphans >/dev/null 2>&1 || true; fi; printf '{"run":"%s","exitCode":%s,"status":"%s"}\n' "$RUNID" "$code" "$(if [ "$code" = 0 ]; then echo PASS; else echo FAIL; fi)" > "$REPORT/result.json"; scripts/docker run --rm --network none -v "$PWD:/workspace" -w /workspace --entrypoint node pawline-local:1 scripts/summarize-verification.mjs "$REPORT" >/dev/null 2>&1 || true; printf '\nVerification %s. Evidence: %s\n' "$code" "$REPORT"; }
trap finish EXIT HUP INT TERM
init_stack(){
 PROJECT="pawline_verify_${RUNID}_$1"; ENVFILE=".local/$PROJECT.env"; export PAWLINE_ENV_FILE="$ENVFILE";
 scripts/docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace --entrypoint node pawline-local:1 scripts/init-test-env.mjs "$PROJECT" "$BASEPORT" "$((BASEPORT+1))"
 dc up -d --no-build --pull never --wait --wait-timeout 120 web worker mailpit > "$REPORT/$1-start.log" 2>&1
 PAWLINE_DATABASE_UI_IMAGE=$(scripts/docker inspect "$(dc ps -q web)" --format '{{.Image}}'); export PAWLINE_DATABASE_UI_IMAGE
 dc up -d --no-deps --no-build --pull never --wait --wait-timeout 60 db-ui >> "$REPORT/$1-start.log" 2>&1
}
browser(){
 suite=$1; shift
 webid=$(dc ps -q web)
 scripts/docker run --rm --network "container:$webid" --env-file "$ENVFILE" -e "QA_DIR=$REPORT/$suite" -e "QA_BROWSER=${QA_BROWSER:-chromium}" -e AUDIT_STAFF=1 -e 'MAIL_ORIGIN=http://mailpit:8025' -e 'DATABASE_UI_ORIGIN=http://db-ui:5555' -e "CONTROL_DIR=${CONTROL_DIR:-}" -v "$PWD/tests:/workspace/tests:ro" -v "$PWD/public:/workspace/public:ro" -v "$PWD/playwright.config.ts:/workspace/playwright.config.ts:ro" -v "$PWD/artifacts:/workspace/artifacts" -v "$PWD/.local/test-results:/workspace/.local/test-results" -v "$PWD/.local/control:/workspace/.local/control" pawline-verify:2 env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy -u NO_PROXY -u no_proxy npx playwright test "$@"
}
mkdir -p .local/control
scripts/docker run --rm --network none -v "$PWD/$REPORT/source-manifest.json:/expected.json:ro" --entrypoint node pawline-local:1 --input-type=module -e 'import fs from "node:fs";import{createHash}from"node:crypto";const m=JSON.parse(fs.readFileSync("/expected.json"));const changed=m.files.filter(f=>createHash("sha256").update(fs.readFileSync(f.path)).digest("hex")!==f.sha256).map(f=>f.path);console.log(JSON.stringify({status:changed.length?"FAIL":"PASS",filesChecked:m.files.length,changed}));if(changed.length)process.exit(1)' > "$REPORT/image-source-recheck.json"
init_stack golden
if sh scripts/reset-demo.sh 1 > "$REPORT/refuse-nondemo.txt" 2>&1; then echo "Unsafe reset accepted non-demo target"; exit 1; fi
if sh scripts/reset-demo.sh > "$REPORT/refuse-no-confirm.txt" 2>&1; then echo "Unsafe reset accepted missing confirmation"; exit 1; fi
dc exec -T web npm run typecheck > "$REPORT/typecheck.log" 2>&1
dc exec -T web npm test > "$REPORT/unit.log" 2>&1
dc exec -T web node scripts/check-packaged-assets.mjs > "$REPORT/packaged-assets.json" 2> "$REPORT/packaged-assets-error.log"
browser golden tests/e2e/golden.spec.ts > "$REPORT/golden-browser.log" 2>&1
dc exec -T db psql -U pawline -d pawline -c 'SELECT type,state,count(*),sum(amount) FROM "SimReceipt" GROUP BY type,state ORDER BY type,state; SELECT state,quantity,canceled,locked FROM "OrderLine" ORDER BY state;' > "$REPORT/golden-sql.txt"
dc --profile database-tools down --remove-orphans > /dev/null 2>&1
# Validate both alternate engines early so browser-environment failures surface promptly.
for engine in webkit firefox; do
 BASEPORT=$((BASEPORT+2)); init_stack "$engine"
 QA_BROWSER=$engine; export QA_BROWSER
 browser "$engine" tests/e2e/database.spec.ts tests/e2e/coco-identity.spec.ts tests/e2e/golden.spec.ts tests/e2e/five-products.spec.ts tests/e2e/checkout-recovery.spec.ts tests/e2e/hardening.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/gallery-paint.spec.ts > "$REPORT/$engine-browser.log" 2>&1
 dc --profile database-tools down --remove-orphans >/dev/null 2>&1
done
QA_BROWSER=chromium; export QA_BROWSER
BASEPORT=$((BASEPORT+2))
init_stack integration
dc stop worker > /dev/null 2>&1
dc exec -T web npx tsx --test --test-reporter=tap tests/integration/ledger.test.ts > "$REPORT/integration.tap" 2>&1
dc --profile database-tools down --remove-orphans > /dev/null 2>&1
BASEPORT=$((BASEPORT+2))
init_stack browser
browser core tests/e2e/database.spec.ts tests/e2e/coco-identity.spec.ts tests/e2e/five-products.spec.ts tests/e2e/security-monitor.spec.ts tests/e2e/usability.spec.ts tests/e2e/checkout-recovery.spec.ts tests/e2e/hardening.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/design-audit.spec.ts tests/e2e/gallery-paint.spec.ts > "$REPORT/core-browser.log" 2>&1
CONTROL_DIR="/workspace/.local/control/$RUNID"; export CONTROL_DIR
mkdir -p ".local/control/$RUNID"
sh scripts/fault-controller.sh "$ENVFILE" ".local/control/$RUNID" > "$REPORT/fault-controller.log" 2>&1 &
CONTROL_PID=$!
browser recovery tests/e2e/faults.spec.ts > "$REPORT/recovery-browser.log" 2>&1
wait "$CONTROL_PID"; CONTROL_PID=''
CONTROL_DIR=''; export CONTROL_DIR
PAWLINE_ENV_FILE="$ENVFILE" sh scripts/backup.sh > "$REPORT/backup.log" 2>&1
BACKUP_DIR=$(cat .local/latest-backup) RESTORE_PORT=$((BASEPORT+2)) RESTORE_MAIL_PORT=$((BASEPORT+3)) sh scripts/verify-restore.sh > "$REPORT/restore.log" 2>&1
dc --profile database-tools down --remove-orphans >/dev/null 2>&1
SAVED_PROJECT=$PROJECT; SAVED_ENVFILE=$ENVFILE; SAVED_EXTRA=$EXTRA
ENVFILE=$(cat .local/latest-restore-env); PROJECT=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ENVFILE"); EXTRA=''
# Reconfigure only this restored stack for browser namespace access at its original origin.
export PAWLINE_ENV_FILE="$ENVFILE"
dc up -d --no-build --pull never --wait --wait-timeout 120 web worker mailpit > "$REPORT/restore-browser-start.log" 2>&1
browser restored tests/e2e/restore.spec.ts > "$REPORT/restore-browser.log" 2>&1
dc --profile database-tools down --remove-orphans >/dev/null 2>&1
PROJECT=$SAVED_PROJECT; ENVFILE=$SAVED_ENVFILE; EXTRA=$SAVED_EXTRA; export PAWLINE_ENV_FILE="$ENVFILE"
BASEPORT=$((BASEPORT+4))
init_stack demo
browser reset_before tests/e2e/first-order.spec.ts > "$REPORT/reset-before.log" 2>&1
sh scripts/reset-demo.sh 1 > "$REPORT/reset.log" 2>&1
dc exec -T db psql -U pawline -d pawline -Atc 'SELECT count(*) FROM "Order"' > "$REPORT/reset-order-count.txt"
[ "$(cat "$REPORT/reset-order-count.txt")" = 0 ] || exit 1
dc --profile database-tools down --remove-orphans >/dev/null 2>&1
BASEPORT=$((BASEPORT+2)); EXTRA='-f compose.offline.yaml'
init_stack offline
webid=$(dc ps -q web)
scripts/docker network inspect "${PROJECT}_local" --format '{{.Internal}}' > "$REPORT/internal-network.txt"
dc exec -T web node -e 'Promise.all([fetch("https://example.com",{signal:AbortSignal.timeout(3000)}).then(()=>{throw Error("Egress unexpectedly available")},()=>"blocked"),fetch("http://127.0.0.1:"+process.env.PORT+"/health/ready").then(r=>r.ok?"reachable":Promise.reject(Error("Internal web unavailable")))]).then(r=>console.log(JSON.stringify({external:r[0],internal:r[1]}))).catch(e=>{console.error(e.message);process.exit(1)})' > "$REPORT/egress-probe.json"
browser offline tests/e2e/golden.spec.ts tests/e2e/security-monitor.spec.ts > "$REPORT/offline-browser.log" 2>&1
dc --profile database-tools down --remove-orphans >/dev/null 2>&1
EXTRA=''
BASEPORT=$((BASEPORT+2)); init_stack pressure
dc exec -T web node scripts/stress.mjs > "$REPORT/pressure.log" 2>&1 || { scripts/docker cp "$(dc ps -aq web):/tmp/pawline-stress.json" "$REPORT/pressure.json" || true; scripts/docker inspect "$(dc ps -aq web)" --format '{"OOMKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"restarts":{{.RestartCount}}}' > "$REPORT/pressure-process.json"; exit 1; }
scripts/docker cp "$(dc ps -q web):/tmp/pawline-stress.json" "$REPORT/pressure.json"
dc exec -T db psql -U pawline -d pawline -c 'SELECT type,state,count(*),sum(amount) FROM "SimReceipt" GROUP BY type,state; SELECT count(*),sum(total) FROM "Order"; SELECT sum(allocated),sum(reserved) FROM "Variant";' > "$REPORT/pressure-independent-sql.txt"
browser pressure_ui tests/e2e/pressure-pagination.spec.ts > "$REPORT/pressure-ui.log" 2>&1
sh scripts/check-service-restart.sh "$ENVFILE" "$REPORT" > "$REPORT/automatic-restart.log" 2>&1
printf 'Every verification stage in this run passed. See the per-stage reports and the private local trace.\n' > "$REPORT/result.txt"
printf '%s\n' "$REPORT" > .local/latest-verification
