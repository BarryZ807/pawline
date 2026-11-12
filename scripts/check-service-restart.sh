#!/bin/sh
set -eu
ENVFILE=$1
REPORT=$2
PROJECT=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ENVFILE")
case "$PROJECT" in pawline_verify_*) ;; *) echo 'Restart probe requires isolated verification stack' >&2; exit 1;; esac
dc(){ PAWLINE_ENV_FILE="$ENVFILE" scripts/docker compose -f compose.yaml -f compose.verify.yaml --env-file "$ENVFILE" -p "$PROJECT" "$@"; }
dc exec -T db psql -U pawline -d pawline -Atc 'SELECT count(*),sum(total) FROM "Order"; SELECT type,state,count(*),sum(amount) FROM "SimReceipt" GROUP BY type,state ORDER BY type,state; SELECT sum(allocated),sum(reserved) FROM "Variant";' > "$REPORT/restart-before.txt"
webid=$(dc ps -q web)
before=$(scripts/docker inspect "$webid" --format '{{.RestartCount}}')
# Terminate the application child from inside its container, not a deliberate Compose stop.
dc exec -T web node -e 'const fs=require("fs");const ids=fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x));const id=ids.find(id=>{try{return fs.readFileSync("/proc/"+id+"/cmdline","utf8").startsWith("next-server")}catch{return false}});if(!id)throw Error("Application process not found");console.log("APPLICATION_EXIT_PROBE");process.kill(Number(id),"SIGKILL")' > "$REPORT/restart-kill.txt" 2>&1 || true
grep -q APPLICATION_EXIT_PROBE "$REPORT/restart-kill.txt"
ready=0
for step in $(seq 1 45); do
 sleep 1
 after=$(scripts/docker inspect "$webid" --format '{{.RestartCount}}')
 if [ "$after" -gt "$before" ] && dc exec -T web node -e 'fetch(process.env.APP_PUBLIC_ORIGIN+"/health/ready",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then ready=1; break; fi
done
[ "$ready" = 1 ] || { echo 'Application did not recover automatically'; exit 1; }
dc exec -T db psql -U pawline -d pawline -Atc 'SELECT count(*),sum(total) FROM "Order"; SELECT type,state,count(*),sum(amount) FROM "SimReceipt" GROUP BY type,state ORDER BY type,state; SELECT sum(allocated),sum(reserved) FROM "Variant";' > "$REPORT/restart-after.txt"
cmp "$REPORT/restart-before.txt" "$REPORT/restart-after.txt"
printf '{"status":"PASS","beforeRestarts":%s,"afterRestarts":%s,"ready":true,"ledgerUnchanged":true}\n' "$before" "$after" > "$REPORT/automatic-restart.json"
