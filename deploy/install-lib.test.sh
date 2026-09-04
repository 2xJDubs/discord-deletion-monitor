#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/install-lib.sh
source "$SCRIPT_DIR/install-lib.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/stage/dist" "$TMP/stage/node_modules/pkg" "$TMP/outside"
ln -s ../node_modules "$TMP/stage/dist/deps"
validate_stage_symlinks "$TMP/stage" || fail "safe in-stage symlink was rejected"
ln -s "$TMP/stage/node_modules/pkg" "$TMP/stage/dist/absolute-in-stage"
if validate_stage_symlinks "$TMP/stage" 2>/dev/null; then
  fail "absolute in-stage symlink was accepted"
fi
rm "$TMP/stage/dist/absolute-in-stage"
ln -s "$TMP/outside" "$TMP/stage/node_modules/external"
if validate_stage_symlinks "$TMP/stage" 2>/dev/null; then
  fail "external symlink was accepted"
fi
rm "$TMP/stage/node_modules/external"
ln -s "$TMP/stage/missing" "$TMP/stage/node_modules/dangling"
if validate_stage_symlinks "$TMP/stage" 2>/dev/null; then
  fail "dangling symlink was accepted"
fi

JOURNAL_MODE=ready
journalctl() {
  if [[ " $* " == *" --show-cursor "* ]]; then
    if [[ " $* " == *" --unit "* ]]; then
      printf '%s\n' '-- No entries --'
    else
      printf '%s\n' '-- cursor: s=cursor-before-start'
    fi
  elif [[ $JOURNAL_MODE == ready ]]; then
    printf '%s\n' '{"level":"info","event":"client_ready","userTag":"bot"}'
  else
    printf '%s\n' '{"level":"info","event":"startup"}'
  fi
}
systemctl() {
  [[ $1 == is-active ]]
}

cursor=$(capture_journal_cursor discord-deletion-monitor.service)
[[ $cursor == s=cursor-before-start ]] || fail "journal cursor was not parsed"
READINESS_POLL_SECONDS=0 wait_for_client_ready discord-deletion-monitor.service "$cursor" 1 || fail "client_ready was not detected"
JOURNAL_MODE=not-ready
if READINESS_POLL_SECONDS=0 wait_for_client_ready discord-deletion-monitor.service "$cursor" 0 2>/dev/null; then
  fail "readiness wait did not time out"
fi

mkdir -p "$TMP/releases/current-release" "$TMP/releases/failed-release"
ln -s "$TMP/releases/current-release" "$TMP/current"
remove_failed_release "$TMP/releases/failed-release" "$TMP/current" "$TMP/releases" || fail "inactive failed release was not removed"
[[ ! -e $TMP/releases/failed-release ]] || fail "failed release remains after rollback cleanup"
mkdir -p "$TMP/releases/active-release"
ln -sfn "$TMP/releases/active-release" "$TMP/current"
if remove_failed_release "$TMP/releases/active-release" "$TMP/current" "$TMP/releases" 2>/dev/null; then
  fail "active release was removed"
fi
[[ -d $TMP/releases/active-release ]] || fail "active release removal guard failed"

ROLLBACK_CALLED=false
fake_rollback() { ROLLBACK_CALLED=true; }
if rollback_failed_deployment 17 true fake_rollback; then
  fail "failed deployment exit status was swallowed"
fi
[[ $ROLLBACK_CALLED == true ]] || fail "active failed deployment did not invoke rollback"
ROLLBACK_CALLED=false
rollback_failed_deployment 0 true fake_rollback || fail "successful deployment exit failed"
[[ $ROLLBACK_CALLED == false ]] || fail "successful deployment invoked rollback"
if rollback_failed_deployment 17 false fake_rollback; then
  fail "pre-transaction failure status was swallowed"
fi
[[ $ROLLBACK_CALLED == false ]] || fail "pre-transaction failure invoked rollback"

mkdir -p "$TMP/switch-releases/previous" "$TMP/switch-releases/failed"
ln -s "$TMP/switch-releases/failed" "$TMP/switch-current"
ln -s "$TMP/switch-releases/failed" "$TMP/switch-tmp"
restore_release_link "$TMP/switch-releases/previous" "$TMP/switch-current" "$TMP/switch-tmp" || \
  fail "release link restoration failed with leftover forward link"
[[ $(readlink -f "$TMP/switch-current") == "$TMP/switch-releases/previous" ]] || \
  fail "leftover forward link restored the failed release"
[[ ! -e $TMP/switch-tmp ]] || fail "temporary release link remained after restoration"

TIMER_ACTIVE=true
systemctl() {
  case "$1" in
    start) TIMER_ACTIVE=true ;;
    stop) TIMER_ACTIVE=false ;;
    *) return 1 ;;
  esac
}
restore_unit_active_state discord-deletion-monitor-backup.timer false || fail "timer inactive state restoration failed"
[[ $TIMER_ACTIVE == false ]] || fail "partially started timer remained active after rollback"
restore_unit_active_state discord-deletion-monitor-backup.timer true || fail "timer active state restoration failed"
[[ $TIMER_ACTIVE == true ]] || fail "previously active timer was not restarted"

SECRET_FILE=$TMP/secret.env
printf '%s\n' 'DISCORD_TOKEN=secret' >"$SECRET_FILE"
chmod 0666 "$SECRET_FILE"
secure_secret_file "$SECRET_FILE" || fail "secret file hardening failed"
[[ $(stat -c '%U:%G:%a' "$SECRET_FILE") == root:root:600 ]] || \
  fail "secret file was not root:root mode 0600"

mkdir -p "$TMP/release-metadata"
printf '%s' 'lock data' >"$TMP/pnpm-lock.yaml"
write_release_metadata "$TMP/release-metadata" deadbeef "$TMP/pnpm-lock.yaml" || \
  fail "release metadata write failed"
grep -qx 'git_commit=deadbeef' "$TMP/release-metadata/RELEASE-METADATA" || \
  fail "release metadata omitted Git commit"
EXPECTED_LOCK_HASH=$(sha256sum "$TMP/pnpm-lock.yaml" | cut -d ' ' -f 1)
grep -qx "lockfile_sha256=$EXPECTED_LOCK_HASH" "$TMP/release-metadata/RELEASE-METADATA" || \
  fail "release metadata omitted lockfile hash"
[[ $(stat -c '%a' "$TMP/release-metadata/RELEASE-METADATA") == 644 ]] || \
  fail "release metadata mode was not 0644"

BACKUP_CALLS=0
fake_online_backup() {
  BACKUP_CALLS=$((BACKUP_CALLS + 1))
  printf 'SQLite format 3\000payload' >"$1/new-backup.db"
}
mkdir -p "$TMP/backups"
printf 'live database' >"$TMP/messages.db"
require_verified_online_backup "$TMP/messages.db" "$TMP/backups" fake_online_backup || \
  fail "new non-empty online backup was not accepted"
[[ $BACKUP_CALLS == 1 ]] || fail "online backup command was not called once"

BACKUP_CALLS=0
require_verified_online_backup "$TMP/missing.db" "$TMP/backups" fake_online_backup || \
  fail "missing database should not require a backup"
[[ $BACKUP_CALLS == 0 ]] || fail "backup ran for a missing database"

unchanged_backup() { :; }
if require_verified_online_backup "$TMP/messages.db" "$TMP/backups" unchanged_backup 2>/dev/null; then
  fail "backup verification accepted no newly created backup"
fi
empty_backup() { : >"$1/empty.db"; }
if require_verified_online_backup "$TMP/messages.db" "$TMP/backups" empty_backup 2>/dev/null; then
  fail "backup verification accepted an empty backup"
fi
invalid_backup() { printf 'not a sqlite database' >"$1/invalid.db"; }
if require_verified_online_backup "$TMP/messages.db" "$TMP/backups" invalid_backup 2>/dev/null; then
  fail "backup verification accepted a non-SQLite backup"
fi

printf '%s\n' "install-lib tests passed"
