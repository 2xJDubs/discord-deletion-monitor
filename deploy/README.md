# Production deployment

These files deploy one Discord Deletion Monitor instance in a dedicated Debian 13 LXC. SQLite must remain on local storage; do not put the database on NFS or run multiple bot replicas against one file.

## Capacity and LXC sizing

Use **1 vCPU, 1 GiB RAM, and a 24 GiB root disk** as the default. A 1 GiB stored-attachment quota, the live database, approximately 15 daily database backups, two rollback releases, the OS, logs, and free-space headroom do not fit safely in 8 GiB; plan on roughly 21 GiB in use before safety margin.

An 8 GiB container is an explicit constrained alternative only if the operator chooses about three local daily backups and relies on tested off-LXC backups. This is not an installer default and does not alter message retention. To opt in, copy the backup unit to `/etc/systemd/system`, change its cleanup predicate from `-daystart -mtime +14` to `-daystart -mtime +2`, run `systemctl daemon-reload`, and document the exception. Monitor actual database size because message text and SQLite overhead are additional to `STORED_ATTACHMENT_MAX_BYTES`.

The container needs outbound HTTPS and DNS, but no inbound public ports.

## Reproducible Debian 13 day-zero bootstrap

The following amd64 example pins Node.js 22.23.2 from the official Node.js distribution and pnpm 11.19.0. For arm64, use the official `linux-arm64` artifact instead. Review and update the pinned Node patch after checking the [official Node.js release index](https://nodejs.org/dist/); do not switch to an unverified third-party package repository.

```bash
sudo apt-get update
sudo apt-get install --yes ca-certificates curl xz-utils git openssh-client \
  util-linux procps systemd sqlite3

NODE_VERSION=v22.23.2
NODE_ARCH=linux-x64
cd /var/tmp
curl --fail --show-error --silent --remote-name \
  "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
curl --fail --show-error --silent --remote-name \
  "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
grep " node-${NODE_VERSION}-${NODE_ARCH}.tar.xz\$" SHASUMS256.txt | sha256sum --check --strict
sudo tar --extract --xz --file "node-${NODE_VERSION}-${NODE_ARCH}.tar.xz" \
  --directory /usr/local --strip-components=1
sudo npm install --global pnpm@11.19.0

node --version
pnpm --version
command -v git flock pgrep pkill systemctl systemd-analyze sha256sum sqlite3
systemd-analyze --version
```

`util-linux` supplies `flock`, `procps` supplies `pgrep`/`pkill`, and `systemd` supplies the unit tooling. The installer additionally requires a normal Git checkout with a resolvable `HEAD`.

For a private repository, provision a read-only GitHub deploy key or an administrator's SSH agent first, verify GitHub's SSH host key using GitHub's published fingerprints, and then clone without embedding a credential:

```bash
git clone git@github.com:2xJDubs/discord-deletion-monitor.git
cd discord-deletion-monitor
git status --short --branch
git rev-parse --verify HEAD
```

Alternatively authenticate interactively with an already-installed official `gh` CLI and use `gh repo clone`. Never put a personal access token in a clone URL, command line, shell history, environment file, or this guide.

## Install and preflight

Enable Discord **Message Content Intent**, then from the trusted checkout:

```bash
node --version                 # supported: >=22.13; production bootstrap uses 22 LTS
pnpm --version                 # exactly 11.19.0
git diff --check
bash -n deploy/*.sh
sudo ./deploy/install.sh
sudoedit /etc/discord-deletion-monitor.env
sudo chown root:root /etc/discord-deletion-monitor.env /etc/discord-deletion-monitor-backup.env
sudo chmod 0600 /etc/discord-deletion-monitor.env /etc/discord-deletion-monitor-backup.env
sudo systemctl start discord-deletion-monitor
sudo systemctl enable --now discord-deletion-monitor-backup.timer
```

Set `RETENTION_MINUTES=60` in `/etc/discord-deletion-monitor.env`. Upgrades temporarily accept legacy `RETENTION_HOURS` only when `RETENTION_MINUTES` is absent; the minute setting takes precedence. After startup, run `/monitor review-channel`, `/monitor setup`, and `/monitor diagnostics` in every server. The setup wizard asks for 1–25 monitored text channels, reports channels hidden by Discord category/channel overwrites, waits for an administrator to grant the **Deletion Monitor** role **View Channel**, rechecks access, and replaces the existing monitored-channel list only after confirmation. It does not request `Administrator` or `Manage Roles` and never changes Discord permissions itself.

Both environment files are deliberately `root:root` mode `0600`. The systemd manager reads `EnvironmentFile=` while privileged and supplies the parsed environment before starting the unprivileged process; the `discord-monitor` account does not need filesystem read permission. The installer creates and repairs these permissions on every run and rejects symlinked/non-regular environment files. Verify the configured paths and effective permissions:

```bash
systemctl cat discord-deletion-monitor.service | grep '^EnvironmentFile='
systemctl cat discord-deletion-monitor-backup.service | grep '^EnvironmentFile='
stat -c '%U:%G %a %n' /etc/discord-deletion-monitor*.env
systemctl show discord-deletion-monitor.service -p EnvironmentFiles
```

The installer builds and tests as the unprivileged `discord-monitor-build` account, rejects escaping staged symlinks, creates immutable versioned releases, and atomically switches `/opt/discord-deletion-monitor/current`. Every release includes `RELEASE-METADATA` with `git_commit` and `lockfile_sha256`. Startup must emit structured `client_ready` within 90 seconds.

Installed state:

- releases: `/opt/discord-deletion-monitor/releases/<release-id>`
- active symlink: `/opt/discord-deletion-monitor/current`
- data: `/var/lib/discord-deletion-monitor`
- backups: `/var/backups/discord-deletion-monitor`
- root-only environments: `/etc/discord-deletion-monitor.env` and `/etc/discord-deletion-monitor-backup.env`
- service account: `discord-monitor` (no login shell)

## Update, backup gate, and guarded rollback

Update a trusted checkout and review it before running `sudo ./deploy/update.sh`. If `messages.db` exists, activation is blocked until the already-built and tested **new release's** backup CLI opens the source through its non-migrating backup path, creates and integrity-checks a new backup, and the installer independently confirms a new regular file with a SQLite header. The gate runs before the active symlink changes, including on a first install importing an existing database.

The installer snapshots previous unit files, enabled/active states, and the previous release link. Failed activation restores those states and removes the failed release. Security repairs to environment-file ownership/mode are intentionally not made less secure during rollback.

Automatic rollback only proves that the prior binary starts against the current database. Database migrations can be forward-only, so inspect release notes/schema changes before manually rolling back. For a guarded manual rollback:

```bash
sudo systemctl stop discord-deletion-monitor
readlink -f /opt/discord-deletion-monitor/current
sudo ls -1 /opt/discord-deletion-monitor/releases/*/RELEASE-METADATA
# Compare git_commit and lockfile_sha256 with the reviewed checkout and lockfile.
# Confirm schema compatibility before selecting OLD_RELEASE.
OLD_RELEASE=/opt/discord-deletion-monitor/releases/REVIEWED_RELEASE_ID
sudo ln -s "$OLD_RELEASE" /opt/discord-deletion-monitor/.current.manual
sudo mv -Tf /opt/discord-deletion-monitor/.current.manual /opt/discord-deletion-monitor/current
sudo systemctl start discord-deletion-monitor
sudo journalctl -u discord-deletion-monitor --since '2 minutes ago' --no-pager | grep '"event":"client_ready"'
```

If schema compatibility is unknown, restore the pre-update database backup together with the matching release instead of starting an old binary on a newer schema.

## Backup policy and exact retention semantics

The timer runs daily at approximately 03:15 local container time and uses SQLite's online backup API. Cleanup is exactly:

```bash
find /var/backups/discord-deletion-monitor -type f -name '*.db' -daystart -mtime +14 -delete
```

GNU `find` measures from the start of today; `+14` selects files whose rounded age is greater than 14 complete calendar-day buckets. With one daily run, this retains approximately 15 daily backups (boundary timing can retain one extra). Only regular `*.db` files are deleted. Copy backups off-LXC with equivalent access controls.

## Safe restore runbook

Use a standalone online-backup `.db`, not a raw copy of a live WAL database.

1. Stop and prove the bot is stopped:
   ```bash
   sudo systemctl stop discord-deletion-monitor
   sudo systemctl is-active discord-deletion-monitor && exit 1 || true
   ```
2. Preserve the complete live state, including WAL/SHM, without overwriting it:
   ```bash
   stamp=$(date -u +%Y%m%dT%H%M%SZ)
   sudo install -d -o root -g root -m 0700 "/var/lib/discord-deletion-monitor/restore-$stamp"
   for f in messages.db messages.db-wal messages.db-shm; do
     sudo test ! -e "/var/lib/discord-deletion-monitor/$f" || \
       sudo mv "/var/lib/discord-deletion-monitor/$f" "/var/lib/discord-deletion-monitor/restore-$stamp/$f"
   done
   ```
3. Copy the selected candidate to a root-only staging path on the **same filesystem** and validate it without permitting writes:
   ```bash
   candidate=/var/backups/discord-deletion-monitor/SELECTED.db
   sudo install -o root -g root -m 0600 "$candidate" \
     /var/lib/discord-deletion-monitor/.messages.db.restore
   sudo sqlite3 'file:/var/lib/discord-deletion-monitor/.messages.db.restore?mode=ro&immutable=1' \
     'PRAGMA quick_check;' | grep -x ok
   sudo sqlite3 'file:/var/lib/discord-deletion-monitor/.messages.db.restore?mode=ro&immutable=1' \
     'PRAGMA foreign_key_check;' | { ! grep -q .; }
   ```
   The application's backup CLI opens its source through a non-migrating path (it does not apply schema migrations while producing a backup), so it is safe to use for creating the candidate backup itself. It is still not a read-only *validation* command, so validate the staged restore candidate with the immutable SQLite checks above rather than by opening it through the application. A future `maintenance check --read-only` command is a **design placeholder only and must not be run or scripted until it exists**.
4. Stage permissions and atomically rename within the data filesystem:
   ```bash
   sudo chown discord-monitor:discord-monitor /var/lib/discord-deletion-monitor/.messages.db.restore
   sudo chmod 0600 /var/lib/discord-deletion-monitor/.messages.db.restore
   sudo mv -T /var/lib/discord-deletion-monitor/.messages.db.restore \
     /var/lib/discord-deletion-monitor/messages.db
   ```
5. Capture the journal boundary, start, and require a new `client_ready` event:
   ```bash
   cursor=$(sudo journalctl -n0 --show-cursor --no-pager | sed -n 's/^-- cursor: //p')
   sudo systemctl start discord-deletion-monitor
   sudo journalctl -u discord-deletion-monitor --after-cursor "$cursor" --no-pager
   sudo journalctl -u discord-deletion-monitor --after-cursor "$cursor" -o cat --no-pager \
     | grep -Eq '"event"[[:space:]]*:[[:space:]]*"client_ready"'
   ```
6. Confirm `/monitor settings` and a controlled deletion test. Keep the preserved directory until the drill is signed off. On failure, stop the bot, move the failed restored database plus any new WAL/SHM aside, and atomically return the preserved `messages.db`, `messages.db-wal`, and `messages.db-shm` as one state set.

Practice after initial deployment and after schema changes.

## Operator health checklist

Run after deployment and at least weekly:

```bash
systemctl is-active discord-deletion-monitor
systemctl is-enabled discord-deletion-monitor discord-deletion-monitor-backup.timer
systemctl list-timers discord-deletion-monitor-backup.timer
systemctl show discord-deletion-monitor -p NRestarts -p ActiveEnterTimestamp
journalctl -u discord-deletion-monitor --since '24 hours ago' -p warning --no-pager
journalctl -u discord-deletion-monitor-backup.service --since '48 hours ago' --no-pager
df -h /var/lib/discord-deletion-monitor /var/backups/discord-deletion-monitor
du -sh /var/lib/discord-deletion-monitor /var/backups/discord-deletion-monitor
find /var/backups/discord-deletion-monitor -maxdepth 1 -type f -name '*.db' \
  -printf '%TY-%Tm-%TdT%TH:%TM:%TS %s %p\n' | sort -r | head -n 3
find /var/backups/discord-deletion-monitor -maxdepth 1 -type f -name '*.db' -mmin -1560 -print -quit \
  | grep -q .
```

The last check requires a backup newer than 26 hours; investigate timer/service logs if it fails. Alert on unexpected `NRestarts` growth, repeated restart-limit failures, low free space, stale backups, backup errors, or absence of recent `client_ready`. The service allows five starts in five minutes and then systemd rate-limits the restart loop.

## Security notes

Do not grant Discord Administrator. Restrict the review channel and host access. Treat databases and all backups as sensitive message content. The units use target-verifiable sandbox controls and deliberately avoid speculative syscall filters. Rotate the Discord token immediately if it appears in logs, chat, shell history, or Git.
