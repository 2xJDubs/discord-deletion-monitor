# Production deployment

These files deploy one Discord Deletion Monitor instance in a dedicated Debian 13 LXC. SQLite is local to that instance; do not place the database on NFS or run multiple bot replicas against one file.

## LXC sizing

A reasonable starting point is 1 vCPU, 1 GB RAM, and an 8 GB root disk. Increase disk space if attachment preservation is enabled for busy servers. The container needs outbound HTTPS and DNS, but no inbound public ports.

## Prerequisites

- Node.js 20 or newer (`node` must be available in `/usr/local/bin`, `/usr/bin`, or `/bin`)
- pnpm 11.19.0
- A checkout of this repository
- Discord **Message Content Intent** enabled

## Install

From the repository checkout:

```bash
sudo ./deploy/install.sh
sudoedit /etc/discord-deletion-monitor.env
sudo systemctl start discord-deletion-monitor
sudo systemctl enable --now discord-deletion-monitor-backup.timer
```

The installer copies declared build inputs to a temporary staging directory and runs dependency lifecycle scripts, audit, tests, type checking, and the production build as the unprivileged `discord-monitor-build` account. Installer runs are serialized; lingering build processes and staged symlinks escaping the build root are rejected before root installs the frozen artifacts. Releases are versioned and the `current` symlink is switched atomically. Startup must emit the structured `client_ready` event within 90 seconds; otherwise the previous release and systemd units are restored. It creates:

- releases: `/opt/discord-deletion-monitor/releases/<release-id>`
- active application symlink: `/opt/discord-deletion-monitor/current`
- database/data: `/var/lib/discord-deletion-monitor`
- bot environment: `/etc/discord-deletion-monitor.env`
- token-free backup environment: `/etc/discord-deletion-monitor-backup.env`
- backups: `/var/backups/discord-deletion-monitor`
- service account: `discord-monitor` (no login shell)

The token file is readable only by root and the service group. Never commit it.

## Verify

```bash
systemctl status discord-deletion-monitor
journalctl -u discord-deletion-monitor -n 100 --no-pager
systemctl list-timers discord-deletion-monitor-backup.timer
sudo systemctl start discord-deletion-monitor-backup.service
ls -l /var/backups/discord-deletion-monitor
```

In Discord, configure a private review channel and run `/monitor test` before enabling broad monitoring.

## Update

Update a trusted checkout, review the diff, then run:

```bash
sudo ./deploy/update.sh
```

The updater reuses the same unprivileged staged-build and atomic-release path as the installer. It does not replace either environment file or the database. Updated systemd units are installed and reloaded. The bot is restarted only after verification succeeds, and the previous release is restored if startup fails.

## Backup policy

The timer runs daily at approximately 3:15 AM local container time. It uses SQLite's online backup API rather than copying a live WAL database. Backups older than 14 days are deleted. Copy important backups to storage outside the LXC as part of the Proxmox backup policy.

Run an on-demand backup:

```bash
sudo systemctl start discord-deletion-monitor-backup.service
sudo journalctl -u discord-deletion-monitor-backup.service -n 50 --no-pager
```

## Restore drill

1. Stop the bot: `sudo systemctl stop discord-deletion-monitor`.
2. Preserve the current database and any `-wal`/`-shm` files in a separate directory.
3. Copy the selected backup to `/var/lib/discord-deletion-monitor/messages.db`.
4. Set ownership and permissions:
   `sudo chown discord-monitor:discord-monitor /var/lib/discord-deletion-monitor/messages.db && sudo chmod 600 /var/lib/discord-deletion-monitor/messages.db`.
5. Start the bot and inspect logs.
6. Confirm `/monitor settings` and a controlled deletion test work.

Practice this after initial deployment and after schema changes.

## Security notes

- Do not grant the Discord bot Administrator.
- Restrict access to the review channel to trusted moderators and the bot.
- The database contains message content and preserved attachments. Treat LXC backups as sensitive data.
- The service runs as a non-root account with a read-only OS/application filesystem and write access only to its data directory.
- Rotate the Discord token immediately if it appears in logs, chat, shell history, or Git.
