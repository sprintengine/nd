#!/usr/bin/env bash
# Restores a dump made by infra/backup.sh. See docs/RUNBOOK.md, "Restore a backup".
#
#   infra/restore.sh --list              list the dumps in the bucket
#   infra/restore.sh [KEY]               restore KEY (default: the newest) into
#                                        the scratch database nd_restore_check
#   infra/restore.sh --into nd --yes [KEY]
#                                        replace the live database: restores into
#                                        a staging database, stops api and
#                                        ocpp-gateway, swaps it in (keeping the
#                                        old one), starts them again
#
# Restoring into the scratch database is safe at any time and is how backups
# are tested. Settings come from the environment, falling back to infra/.env.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=backup-lib.sh
. "$here/backup-lib.sh"

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

target="nd_restore_check"
confirmed=false
list_only=false
key=""
while (($# > 0)); do
  case "$1" in
    --list) list_only=true ;;
    --into)
      (($# >= 2)) || usage
      target="$2"
      shift
      ;;
    --yes) confirmed=true ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) key="$1" ;;
  esac
  shift
done

load_settings
require BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

if "$list_only"; then
  list_dumps
  exit 0
fi

# The name is interpolated into SQL below, so allow only plain identifiers.
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "--into takes a plain database name, got '$target'"
[[ "$target" != "postgres" && "$target" != template* ]] || die "refusing to restore into '$target'"
live=false
if [[ "$target" == "$POSTGRES_DB" ]]; then
  live=true
  "$confirmed" || die "'$target' is the live database; add --yes to replace it"
fi

if [[ -z "$key" ]]; then
  key="$(list_dumps | tail -n 1)"
  [[ -n "$key" ]] || die "no dumps found in s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-}"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dump="$work/nd.dump"

log "downloading s3://${BACKUP_S3_BUCKET}/${key}"
s3 s3 cp "s3://${BACKUP_S3_BUCKET}/${key}" - --no-progress >"$dump"
compose exec -T postgres pg_restore --list <"$dump" >/dev/null || die "pg_restore cannot read ${key}"

# The live database is never dropped: the dump goes into a staging database,
# and only once that restore succeeded are the names swapped, keeping the old
# database for a rollback.
staging="$target"
if "$live"; then
  staging="${target}_incoming"
fi

log "recreating database ${staging}"
compose exec -T postgres psql --username "$POSTGRES_USER" --dbname postgres \
  --set ON_ERROR_STOP=1 --quiet \
  --command "DROP DATABASE IF EXISTS \"${staging}\" WITH (FORCE)" \
  --command "CREATE DATABASE \"${staging}\""

log "restoring ${key} into ${staging}"
compose exec -T postgres pg_restore --username "$POSTGRES_USER" --dbname "$staging" \
  --no-owner --exit-on-error <"$dump"

tables="$(compose exec -T postgres psql --username "$POSTGRES_USER" --dbname "$staging" \
  --tuples-only --no-align --command \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'tiger', 'tiger_data', 'topology')")"
log "restored ${key} into ${staging}: ${tables} table(s)"

if ! "$live"; then
  log "inspect it with: docker compose -f infra/compose.yml exec postgres psql -U ${POSTGRES_USER} -d ${target}"
  log "drop it with:    docker compose -f infra/compose.yml exec postgres dropdb -U ${POSTGRES_USER} ${target}"
  exit 0
fi

previous="${target}_before_$(date -u +%Y%m%d%H%M%S)"
log "stopping api and ocpp-gateway"
compose stop api ocpp-gateway
log "swapping databases: ${target} -> ${previous}, ${staging} -> ${target}"
compose exec -T postgres psql --username "$POSTGRES_USER" --dbname postgres \
  --set ON_ERROR_STOP=1 --quiet \
  --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${target}' AND pid <> pg_backend_pid()" \
  --command "ALTER DATABASE \"${target}\" RENAME TO \"${previous}\"" \
  --command "ALTER DATABASE \"${staging}\" RENAME TO \"${target}\"" \
  >/dev/null
log "starting api and ocpp-gateway"
compose up --detach --wait api ocpp-gateway
log "done. Once the restore is checked, drop the old database:"
log "  docker compose -f infra/compose.yml exec postgres dropdb -U ${POSTGRES_USER} ${previous}"
