#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
APP_ROOT=/opt/discord-deletion-monitor
RELEASES_DIR=$APP_ROOT/releases
CURRENT_LINK=$APP_ROOT/current
DATA_DIR=/var/lib/discord-deletion-monitor
BACKUP_DIR=/var/backups/discord-deletion-monitor
ENV_FILE=/etc/discord-deletion-monitor.env
BACKUP_ENV_FILE=/etc/discord-deletion-monitor-backup.env
SERVICE_USER=discord-monitor
BUILD_USER=discord-monitor-build
BUILD_HOME=/var/lib/discord-monitor-build
SAFE_PATH=/usr/local/bin:/usr/bin:/bin
READINESS_TIMEOUT_SECONDS=90
# shellcheck source=deploy/install-lib.sh
source "$SOURCE_DIR/deploy/install-lib.sh"

command -v node >/dev/null || { echo "Node.js 20+ is required." >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm 11.19.0 is required." >&2; exit 1; }
command -v flock >/dev/null || { echo "flock is required." >&2; exit 1; }
command -v pgrep >/dev/null || { echo "pgrep is required." >&2; exit 1; }
command -v pkill >/dev/null || { echo "pkill is required." >&2; exit 1; }
NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
(( NODE_MAJOR >= 20 )) || { echo "Node.js 20+ is required." >&2; exit 1; }
[[ $(pnpm --version) == 11.19.0 ]] || { echo "pnpm 11.19.0 is required." >&2; exit 1; }

INSTALL_LOCK=/run/lock/discord-deletion-monitor-install.lock
exec {INSTALL_LOCK_FD}>"$INSTALL_LOCK"
if ! flock --nonblock "$INSTALL_LOCK_FD"; then
  echo "Another discord-deletion-monitor installation is already running." >&2
  exit 1
fi

id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
id "$BUILD_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$BUILD_HOME" --shell /usr/sbin/nologin "$BUILD_USER"
install -d -o root -g root -m 0755 "$APP_ROOT" "$RELEASES_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR" "$BACKUP_DIR"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 "$BUILD_HOME"

STAGE=$(mktemp -d /var/tmp/discord-monitor-build.XXXXXXXX)
chown "$BUILD_USER:$BUILD_USER" "$STAGE"
LINK_TMP=$APP_ROOT/.current.$$
DEPLOYMENT_ACTIVE=false
ROLLBACK_DONE=false
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && [[ $ROLLBACK_DONE != true ]]; then
    if [[ $DEPLOYMENT_ACTIVE == true ]]; then
      rollback_failed_deployment "$status" true rollback_deployment || true
    elif [[ -n ${RELEASE_DIR:-} && -d ${RELEASE_DIR:-} ]]; then
      remove_failed_release "$RELEASE_DIR" "$CURRENT_LINK" "$RELEASES_DIR" || true
    fi
  fi
  rm -rf -- "$STAGE"
  rm -f -- "$LINK_TMP"
  exit "$status"
}
trap cleanup EXIT

# Root copies only declared build inputs; dependency scripts run as BUILD_USER.
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 "$STAGE/src"
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json; do
  install -o "$BUILD_USER" -g "$BUILD_USER" -m 0644 "$SOURCE_DIR/$file" "$STAGE/$file"
done
cp -a "$SOURCE_DIR/src/." "$STAGE/src/"
chown -R "$BUILD_USER:$BUILD_USER" "$STAGE/src"

run_build() {
  runuser -u "$BUILD_USER" -- env HOME="$BUILD_HOME" PATH="$SAFE_PATH" "$@"
}

# mktemp creates the stage as root:root 0700. Verify the unprivileged build
# user can traverse it before invoking any package lifecycle scripts.
run_build test -x "$STAGE"
run_build pnpm --dir "$STAGE" install --frozen-lockfile
run_build pnpm --dir "$STAGE" audit --prod
run_build pnpm --dir "$STAGE" test
run_build pnpm --dir "$STAGE" typecheck
run_build pnpm --dir "$STAGE" build
run_build pnpm --dir "$STAGE" prune --prod
# The build account is dedicated to this installer. Stop lifecycle-script
# descendants before changing ownership; otherwise an already-open writable FD
# could mutate output after chown and race validation/copy.
if pgrep -u "$BUILD_USER" >/dev/null; then
  pkill -TERM -u "$BUILD_USER" || true
  for _ in {1..20}; do
    pgrep -u "$BUILD_USER" >/dev/null || break
    sleep 0.1
  done
fi
if pgrep -u "$BUILD_USER" >/dev/null; then
  pkill -KILL -u "$BUILD_USER" || true
  for _ in {1..20}; do
    pgrep -u "$BUILD_USER" >/dev/null || break
    sleep 0.1
  done
fi
if pgrep -u "$BUILD_USER" >/dev/null; then
  echo "Unable to terminate lingering build-user processes." >&2
  exit 1
fi
# Freeze build-owned output before validation so a lifecycle-script child cannot
# race the symlink check and the privileged copy into /opt.
chown -R root:root "$STAGE"
validate_stage_symlinks "$STAGE"

RELEASE_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
RELEASE_DIR=$RELEASES_DIR/$RELEASE_ID
install -d -o root -g root -m 0755 "$RELEASE_DIR"
cp -a "$STAGE/dist" "$STAGE/node_modules" "$RELEASE_DIR/"
install -o root -g root -m 0644 "$STAGE/package.json" "$STAGE/pnpm-lock.yaml" "$RELEASE_DIR/"
chown -R root:root "$RELEASE_DIR"
find "$RELEASE_DIR" -type d -exec chmod go-w {} +
find "$RELEASE_DIR" -type f -exec chmod go-w {} +

PREVIOUS_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)

UNIT_NAMES=(
  discord-deletion-monitor.service
  discord-deletion-monitor-backup.service
  discord-deletion-monitor-backup.timer
)
UNIT_BACKUP_DIR=$STAGE/unit-backup
install -d -o root -g root -m 0700 "$UNIT_BACKUP_DIR"
for unit in "${UNIT_NAMES[@]}"; do
  if [[ -f /etc/systemd/system/$unit ]]; then
    install -o root -g root -m 0644 "/etc/systemd/system/$unit" "$UNIT_BACKUP_DIR/$unit"
  fi
done
SERVICE_WAS_ENABLED=false
TIMER_WAS_ENABLED=false
systemctl is-enabled --quiet discord-deletion-monitor.service && SERVICE_WAS_ENABLED=true
systemctl is-enabled --quiet discord-deletion-monitor-backup.timer && TIMER_WAS_ENABLED=true
SERVICE_WAS_ACTIVE=false
systemctl is-active --quiet discord-deletion-monitor.service && SERVICE_WAS_ACTIVE=true
TIMER_WAS_ACTIVE=false
systemctl is-active --quiet discord-deletion-monitor-backup.timer && TIMER_WAS_ACTIVE=true
ENV_WAS_PRESENT=false
BACKUP_ENV_WAS_PRESENT=false
[[ -e $ENV_FILE ]] && ENV_WAS_PRESENT=true
[[ -e $BACKUP_ENV_FILE ]] && BACKUP_ENV_WAS_PRESENT=true

restore_units() {
  local unit
  for unit in "${UNIT_NAMES[@]}"; do
    if [[ -f $UNIT_BACKUP_DIR/$unit ]]; then
      install -o root -g root -m 0644 "$UNIT_BACKUP_DIR/$unit" "/etc/systemd/system/$unit"
    else
      rm -f -- "/etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload
  if [[ $SERVICE_WAS_ENABLED == true ]]; then
    systemctl enable discord-deletion-monitor.service >/dev/null || true
  else
    systemctl disable discord-deletion-monitor.service >/dev/null || true
  fi
  if [[ $TIMER_WAS_ENABLED == true ]]; then
    systemctl enable discord-deletion-monitor-backup.timer >/dev/null || true
  else
    systemctl disable discord-deletion-monitor-backup.timer >/dev/null || true
  fi
  restore_unit_active_state discord-deletion-monitor-backup.timer "$TIMER_WAS_ACTIVE" || \
    echo "Warning: prior backup timer active state could not be restored." >&2
}

rollback_deployment() {
  systemctl stop discord-deletion-monitor.service || true
  restore_release_link "$PREVIOUS_RELEASE" "$CURRENT_LINK" "$LINK_TMP" || \
    echo "Warning: prior release link could not be restored." >&2
  restore_units || echo "Warning: prior systemd units could not be fully restored." >&2
  [[ $ENV_WAS_PRESENT == true ]] || rm -f -- "$ENV_FILE"
  [[ $BACKUP_ENV_WAS_PRESENT == true ]] || rm -f -- "$BACKUP_ENV_FILE"
  if [[ $SERVICE_WAS_ACTIVE == true && -n $PREVIOUS_RELEASE && -d $PREVIOUS_RELEASE ]]; then
    systemctl restart discord-deletion-monitor.service || \
      echo "Warning: the previous release could not be restarted." >&2
  fi
  remove_failed_release "$RELEASE_DIR" "$CURRENT_LINK" "$RELEASES_DIR" || \
    echo "Warning: failed release could not be removed: $RELEASE_DIR" >&2
  ROLLBACK_DONE=true
}

start_and_wait_ready() {
  local action=$1
  local cursor
  cursor=$(capture_journal_cursor discord-deletion-monitor.service) || return 1
  systemctl "$action" discord-deletion-monitor.service || return 1
  wait_for_client_ready discord-deletion-monitor.service "$cursor" "$READINESS_TIMEOUT_SECONDS"
}

# From this point onward every failure must restore both the prior release and
# the prior unit files before the EXIT trap deletes the staged unit backups.
DEPLOYMENT_ACTIVE=true
ln -s "$RELEASE_DIR" "$LINK_TMP"
mv -Tf "$LINK_TMP" "$CURRENT_LINK"

install -o root -g root -m 0644 "$SOURCE_DIR/deploy/discord-deletion-monitor.service" /etc/systemd/system/
install -o root -g root -m 0644 "$SOURCE_DIR/deploy/discord-deletion-monitor-backup.service" /etc/systemd/system/
install -o root -g root -m 0644 "$SOURCE_DIR/deploy/discord-deletion-monitor-backup.timer" /etc/systemd/system/

if [[ ! -e "$ENV_FILE" ]]; then
  install -o root -g "$SERVICE_USER" -m 0640 "$SOURCE_DIR/deploy/discord-deletion-monitor.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Set DISCORD_TOKEN before starting the service."
fi
if [[ ! -e "$BACKUP_ENV_FILE" ]]; then
  install -o root -g "$SERVICE_USER" -m 0640 "$SOURCE_DIR/deploy/discord-deletion-monitor-backup.env.example" "$BACKUP_ENV_FILE"
fi

systemctl daemon-reload
systemctl enable discord-deletion-monitor.service discord-deletion-monitor-backup.timer

TOKEN_READY=false
if grep -q '^DISCORD_TOKEN=' "$ENV_FILE" && ! grep -q '^DISCORD_TOKEN=replace-with-your-bot-token$' "$ENV_FILE"; then
  TOKEN_READY=true
fi

if [[ $SERVICE_WAS_ACTIVE == true ]]; then
  if ! start_and_wait_ready restart; then
    echo "New release did not become ready; rolling back release and units." >&2
    rollback_deployment || true
    exit 1
  fi
elif [[ $TOKEN_READY == true ]]; then
  if ! start_and_wait_ready start; then
    echo "Initial service start did not become ready; restoring prior units." >&2
    rollback_deployment || true
    exit 1
  fi
fi
systemctl enable --now discord-deletion-monitor-backup.timer
DEPLOYMENT_ACTIVE=false

# Keep the current release, the previous release, and one additional rollback.
mapfile -t ALL_RELEASES < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%p\n' | sort -r)
EXTRA_KEPT=0
for release in "${ALL_RELEASES[@]}"; do
  if [[ $release == "$RELEASE_DIR" || $release == "$PREVIOUS_RELEASE" ]]; then
    continue
  fi
  if (( EXTRA_KEPT == 0 )); then
    EXTRA_KEPT=1
    continue
  fi
  rm -rf -- "$release"
done

echo "Installed release $RELEASE_ID."
if [[ $TOKEN_READY != true ]]; then
  echo "Edit $ENV_FILE, then run: systemctl start discord-deletion-monitor"
fi
