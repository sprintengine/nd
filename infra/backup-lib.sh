# Helpers shared by infra/backup.sh and infra/restore.sh. Not run directly.
# shellcheck shell=bash

# aws-cli 2.42.4, pinned by digest. Override only to test against another store.
AWS_CLI_IMAGE="${BACKUP_AWS_CLI_IMAGE:-amazon/aws-cli:2.42.4@sha256:4a1a668837d5f97ced202e03827da1bc0b48cda946be89909cd7a02023f62921}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

# Reads KEY=value lines from the env file (ND_ENV_FILE, default infra/.env).
# Variables already set in the environment win. The file is parsed, never
# sourced, so a value is never run as shell code.
load_settings() {
  ND_ENV_FILE="${ND_ENV_FILE:-$here/.env}"
  ND_COMPOSE_FILE="${ND_COMPOSE_FILE:-$here/compose.yml}"
  local line name value
  if [[ -f "$ND_ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
      [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
      name="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      if [[ -z "${!name+set}" ]]; then
        export "$name=$value"
      fi
    done <"$ND_ENV_FILE"
  fi
  POSTGRES_USER="${POSTGRES_USER:-nd}"
  POSTGRES_DB="${POSTGRES_DB:-nd}"
}

require() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "$name is not set (environment or ${ND_ENV_FILE})"
  done
}

compose() {
  local args=(compose --file "$ND_COMPOSE_FILE")
  if [[ -f "$ND_ENV_FILE" ]]; then
    args+=(--env-file "$ND_ENV_FILE")
  fi
  docker "${args[@]}" "$@"
}

# Runs the aws CLI against the backup bucket. Credentials reach the container
# through the environment, never the command line.
s3() {
  local args=(run --rm -i
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION
    # Cloudflare R2 rejects the checksum headers newer aws-cli versions send by default.
    -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required
    -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required)
  # Only needed when the object store is itself a container (tests).
  if [[ -n "${BACKUP_DOCKER_NETWORK:-}" ]]; then
    args+=(--network "$BACKUP_DOCKER_NETWORK")
  fi
  local endpoint=()
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
    endpoint=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  fi
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
    docker "${args[@]}" "$AWS_CLI_IMAGE" "$@" ${endpoint[@]+"${endpoint[@]}"}
}

# Object key for a dump taken at the given UTC stamp (YYYYMMDDTHHMMSSZ).
dump_key() {
  printf '%snd-%s.dump' "${BACKUP_S3_PREFIX:-}" "$1"
}

# UTC stamp of the moment N days ago, with GNU date (Linux) or BSD date (macOS).
stamp_days_ago() {
  local epoch=$(($(date -u +%s) - $1 * 86400))
  date -u -d "@$epoch" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$epoch" +%Y%m%dT%H%M%SZ
}

# Prints the key of every dump in the bucket, oldest first.
list_dumps() {
  local prefix="${BACKUP_S3_PREFIX:-}" listing
  listing="$(s3 s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "${prefix}nd-" \
    --query 'Contents[].Key' --output text)" || die "cannot list s3://${BACKUP_S3_BUCKET}/${prefix}"
  # Anything else under the prefix (and the CLI's "None" for no objects) is skipped.
  tr '\t' '\n' <<<"$listing" |
    grep -E "^${prefix//./\\.}nd-[0-9]{8}T[0-9]{6}Z\\.dump$" |
    sort || true
}
