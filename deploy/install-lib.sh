#!/usr/bin/env bash

validate_stage_symlinks() {
  local stage=$1
  local stage_real link raw_target target
  stage_real=$(readlink -e -- "$stage") || return 1

  while IFS= read -r -d '' link; do
    raw_target=$(readlink -- "$link") || return 1
    if [[ $raw_target == /* ]]; then
      echo "Rejecting absolute staged symlink: $link -> $raw_target" >&2
      return 1
    fi
    if ! target=$(readlink -e -- "$link"); then
      echo "Rejecting dangling staged symlink: $link" >&2
      return 1
    fi
    case "$target" in
      "$stage_real"|"$stage_real"/*) ;;
      *)
        echo "Rejecting staged symlink outside build root: $link -> $target" >&2
        return 1
        ;;
    esac
  done < <(find "$stage/dist" "$stage/node_modules" -type l -print0)
}

remove_failed_release() {
  local release=$1
  local current_link=$2
  local releases_dir=$3
  local release_real releases_real current_real

  releases_real=$(readlink -e -- "$releases_dir") || return 1
  release_real=$(readlink -e -- "$release") || return 1
  [[ -d $release_real && $(dirname -- "$release_real") == "$releases_real" ]] || {
    echo "Refusing to remove unsafe failed release path: $release" >&2
    return 1
  }
  current_real=$(readlink -f -- "$current_link" 2>/dev/null || true)
  [[ $current_real != "$release_real" ]] || {
    echo "Refusing to remove the active release: $release_real" >&2
    return 1
  }
  rm -rf -- "$release_real"
}

rollback_failed_deployment() {
  local status=$1
  local deployment_active=$2
  local rollback_function=$3

  if (( status != 0 )) && [[ $deployment_active == true ]]; then
    "$rollback_function" || true
  fi
  return "$status"
}

restore_release_link() {
  local previous_release=$1
  local current_link=$2
  local temporary_link=$3

  # A failed forward mv may leave temporary_link pointing at the failed
  # release. Never reuse it as rollback input.
  rm -f -- "$temporary_link"
  if [[ -n $previous_release && -d $previous_release ]]; then
    ln -s "$previous_release" "$temporary_link"
    mv -Tf "$temporary_link" "$current_link"
  else
    rm -f -- "$current_link"
  fi
}

restore_unit_active_state() {
  local unit=$1
  local was_active=$2
  if [[ $was_active == true ]]; then
    systemctl start "$unit"
  else
    systemctl stop "$unit"
  fi
}

secure_secret_file() {
  local path=$1
  [[ -f $path && ! -L $path ]] || {
    echo "Refusing to secure a missing, non-regular, or symlinked secret file: $path" >&2
    return 1
  }
  chown root:root "$path"
  chmod 0600 "$path"
}

write_release_metadata() {
  local release=$1
  local git_commit=$2
  local lockfile=$3
  local lockfile_sha256 temporary

  lockfile_sha256=$(sha256sum "$lockfile" | cut -d ' ' -f 1) || return 1
  temporary=$release/.RELEASE-METADATA.$$
  printf 'git_commit=%s\nlockfile_sha256=%s\n' "$git_commit" "$lockfile_sha256" >"$temporary"
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$release/RELEASE-METADATA"
}

is_sqlite_database() {
  local path=$1
  local header
  header=$(od -An -tx1 -N16 "$path" | tr -d '[:space:]') || return 1
  [[ $header == 53514c69746520666f726d6174203300 ]]
}

require_verified_online_backup() {
  local database=$1
  local backup_dir=$2
  local backup_function=$3
  local before candidate found=false

  [[ -e $database ]] || return 0
  [[ -f $database && ! -L $database ]] || {
    echo "Database exists but is not a regular, non-symlink file: $database" >&2
    return 1
  }
  before=$(mktemp)
  find "$backup_dir" -maxdepth 1 -type f -name '*.db' -printf '%p\n' | sort >"$before"
  if ! "$backup_function" "$backup_dir"; then
    rm -f -- "$before"
    echo "Required online backup command failed." >&2
    return 1
  fi
  while IFS= read -r candidate; do
    if ! grep -Fqx -- "$candidate" "$before" && \
      [[ -f $candidate && ! -L $candidate && -s $candidate ]] && \
      is_sqlite_database "$candidate"; then
      found=true
      break
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type f -name '*.db' -printf '%p\n' | sort)
  rm -f -- "$before"
  if [[ $found != true ]]; then
    echo "Online backup did not create a new, non-empty regular .db file." >&2
    return 1
  fi
}

capture_journal_cursor() {
  local service=$1
  local output cursor

  # A unit with no prior entries has no unit-scoped cursor. Fall back to the
  # current global journal tail so the subsequent query still starts strictly
  # after this deployment attempt's boundary.
  output=$(journalctl --unit "$service" --lines=0 --show-cursor --no-pager 2>/dev/null || true)
  cursor=$(sed -n 's/^-- cursor: //p' <<<"$output" | tail -n 1)
  if [[ -z $cursor ]]; then
    output=$(journalctl --lines=0 --show-cursor --no-pager 2>/dev/null || true)
    cursor=$(sed -n 's/^-- cursor: //p' <<<"$output" | tail -n 1)
  fi
  if [[ -z $cursor ]]; then
    echo "Unable to capture journal cursor before service start." >&2
    return 1
  fi
  printf '%s\n' "$cursor"
}

wait_for_client_ready() {
  local service=$1
  local cursor=$2
  local timeout_seconds=$3
  local poll_seconds=${READINESS_POLL_SECONDS:-1}
  local deadline=$((SECONDS + timeout_seconds))
  local entries

  while true; do
    entries=$(journalctl --unit "$service" --after-cursor "$cursor" --output=cat --no-pager 2>/dev/null || true)
    if grep -Eq '"event"[[:space:]]*:[[:space:]]*"client_ready"' <<<"$entries"; then
      return 0
    fi
    if ! systemctl is-active --quiet "$service"; then
      echo "$service exited before emitting client_ready." >&2
      return 1
    fi
    if (( SECONDS >= deadline )); then
      echo "Timed out after ${timeout_seconds}s waiting for $service client_ready." >&2
      return 1
    fi
    sleep "$poll_seconds"
  done
}
