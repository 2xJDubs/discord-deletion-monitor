# Discord Deletion Monitor

A multi-server Discord bot that caches eligible messages and sends evidence to each server's private review channel only when a cached message is deleted.

## Setup

1. Create a Discord application and bot in the Developer Portal.
2. Enable the **Message Content Intent**.
3. Invite the bot with `View Channels`, `Read Message History`, `Send Messages`, and `Attach Files` permissions. Do not grant Administrator. Existing category or channel overwrites can still hide channels from the bot.
4. Copy `.env.example` to `.env` and add the bot token.
5. Run `pnpm install`, then `pnpm dev`.
6. Run `/monitor review-channel` in each server and select its private moderator channel.
7. Run `/monitor setup`, select 1–25 monitored text channels, grant the **Deletion Monitor** role **View Channel** where prompted, recheck, and confirm. Confirmation replaces the prior monitored-channel list and selects `all` mode.
8. Run `/monitor role exclude` for every trusted admin or moderator role whose messages should be ignored.
9. Run `/monitor diagnostics` and resolve every reported permission problem.

The `/monitor` command requires `Manage Server`. Configuration and cached evidence are isolated by Discord guild ID.

## Commands

- `/monitor review-channel` sets the private evidence destination.
- `/monitor setup` interactively replaces the monitored-channel list after permission checks and confirmation.
- `/monitor retention` sets cache lifetime from 1 to 129,600 minutes; the default is 60 minutes.
- `/monitor mode` chooses `all` (default) or `matching`.
- `/monitor keyword add|remove` manages watched phrases.
- `/monitor domain add|remove` manages watched domains.
- `/monitor pattern add|remove` manages built-in scam patterns.
- `/monitor channel include|exclude|remove-include|remove-exclude` controls channel scope.
- `/monitor role exclude|remove-exclusion` manages trusted roles that bypass monitoring.
- `/monitor settings` shows the server's configuration.
- `/monitor diagnostics` checks effective monitored-channel and review-channel permissions.
- `/monitor test` checks sample text without saving it.

In `matching` mode, **every message containing a link is cached automatically**, even if the domain is not explicitly listed. Configured keywords, domains, and built-in patterns add further reasons to save a message. Members with Discord's Administrator permission and members with any excluded role are ignored before detection runs.

Messages appear in the review channel only if they are deleted. Evidence remains in SQLite until every Discord payload succeeds or retention expires; missing channels and transient failures are retried with persisted exponential backoff, including after process restarts. Atomic delivery leases prevent duplicate immediate/retry workers, and completed payload-batch progress is persisted so partial retries resume without reposting earlier batches. Undeleted cached messages are purged after the per-server retention period. Copied text has Markdown and mention syntax neutralized. Content that would exceed Discord's 2,000-character limit is delivered as a UTF-8 text attachment, and files are split into Discord-safe batches of ten.

Attachment bytes are downloaded at message creation and stored durably in SQLite. Per-message limits, a bounded global capture queue, and `STORED_ATTACHMENT_MAX_BYTES` constrain memory and disk use; queue overflow still saves message text. Failed or aborted downloads are logged without dropping the message text. Stored attachment rows are cascade-deleted when evidence is delivered or expires.

## Operations

Build before invoking the online-backup CLI. It accepts a destination directory and creates a timestamped `.db` file there while the bot can remain online:

```sh
pnpm build
node dist/backup.js /var/backups/discord-deletion-monitor
# equivalent package script:
pnpm backup -- /var/backups/discord-deletion-monitor
```

SQLite runs with foreign keys enabled, WAL mode, and a configurable busy timeout (`DATABASE_BUSY_TIMEOUT_MS`). `SIGINT` and `SIGTERM` stop accepting work, stop retry/purge timers, abort downloads, drain active handlers within `SHUTDOWN_DRAIN_TIMEOUT_MS`, destroy Discord, checkpoint WAL, and close SQLite exactly once. Logs are single-line JSON; set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`.

For the hardened `systemd` deployment, daily backup timer, install/update scripts, restore drill, and LXC guidance, see [`deploy/README.md`](deploy/README.md). Data handling and retention are documented in [`docs/data-retention.md`](docs/data-retention.md).

Production operators should use a 24 GiB root disk with the default 1 GiB attachment quota and approximately 15 local daily backups. Both `/etc/discord-deletion-monitor.env` files are installed as `root:root` mode `0600`; systemd reads `EnvironmentFile=` before dropping to the service user. Updates require a newly verified online backup before release activation and record the Git commit plus lockfile hash in each release. Follow the guarded restore/rollback procedures and health checklist in the deployment guide rather than copying a live WAL database.
