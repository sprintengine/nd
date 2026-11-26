#!/usr/bin/env bash
# Dumps the Compose Postgres to S3-compatible object storage (Cloudflare R2 or
# any S3 API), then deletes dumps older than BACKUP_RETENTION_DAYS (30).
#
#   infra/backup.sh
#
# Run it nightly from root's crontab on the VM, for example:
#
#   15 3 * * * /opt/nd/infra/backup.sh >> /var/log/nd-backup.log 2>&1
#
# Settings come from the environment, falling back to infra/.env (see
# infra/.env.example, "Backups"). Needs only Docker on the host: pg_dump runs
# in the postgres container and the upload in a pinned aws-cli container.
# Restore with infra/restore.sh (docs/RUNBOOK.md, "Restore a backup").
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=backup-lib.sh
. "$here/backup-lib.sh"

load_settings
require BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

retention_days="${BACKUP_RETENTION_DAYS:-30}"
if ! [[ "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  die "BACKUP_RETENTION_DAYS must be a positive whole number of days, got '$retention_days'"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
key="$(dump_key "$stamp")"
dump="$work/nd.dump"

log "dumping database ${POSTGRES_DB} from the postgres service"
# Custom format: compressed, and pg_restore can restore selectively from it.
compose exec -T postgres \
  pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format custom --compress 6 \
  >"$dump"

# A dump that pg_restore cannot list is not a backup; stop before uploading it
# or pruning older ones.
compose exec -T postgres pg_restore --list <"$dump" >/dev/null ||
  die "pg_restore cannot read the dump; nothing uploaded"
size="$(wc -c <"$dump" | tr -d ' ')"
log "dump is ${size} bytes"

log "uploading to s3://${BACKUP_S3_BUCKET}/${key}"
s3 s3 cp - "s3://${BACKUP_S3_BUCKET}/${key}" --no-progress <"$dump" >/dev/null

# Only after a successful upload: delete dumps older than the retention period.
# Keys carry their UTC timestamp, so string comparison orders them by age.
cutoff="$(stamp_days_ago "$retention_days")"
pruned=0
while IFS= read -r old_key; do
  old_stamp="${old_key#"${BACKUP_S3_PREFIX:-}"nd-}"
  old_stamp="${old_stamp%.dump}"
  if [[ "$old_stamp" < "$cutoff" ]]; then
    log "deleting s3://${BACKUP_S3_BUCKET}/${old_key} (older than ${retention_days} days)"
    s3 s3 rm "s3://${BACKUP_S3_BUCKET}/${old_key}" >/dev/null
    pruned=$((pruned + 1))
  fi
done < <(list_dumps)

log "backup ${key} done; deleted ${pruned} dump(s) older than ${retention_days} days"
