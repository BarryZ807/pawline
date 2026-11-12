.PHONY: start demo verify down reset-demo backup-demo verify-restore logs credentials database database-status db-counts db-trace

start:
	@sh scripts/start.sh

demo:
	@sh scripts/demo.sh

verify:
	@sh scripts/verify.sh

down:
	@scripts/docker compose --profile database-tools down

database:
	@sh scripts/database-ui.sh

database-status:
	@sh scripts/database.sh status

db-counts:
	@sh scripts/database.sh counts

db-trace:
	@sh scripts/database.sh trace "$(ORDER)"

reset-demo:
	@sh scripts/reset-demo.sh "$(CONFIRM)"

backup-demo:
	@sh scripts/backup.sh

verify-restore:
	@sh scripts/verify-restore.sh

logs:
	@scripts/docker compose logs --tail 100 web worker

credentials:
	@cat .local/credentials.txt
