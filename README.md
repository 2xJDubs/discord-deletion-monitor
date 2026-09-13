# Discord Deletion Monitor

A multi-server Discord bot that caches eligible messages and sends evidence to each server's private review channel only when a cached message is deleted.

## Prerequisites and supported hosts

- Node.js **22.13 or newer** (production uses Node 22 LTS), pnpm **11.19.0**, Git, outbound HTTPS/DNS, and a Discord account allowed to create applications and use **Manage Server** in each target guild.
- Local development is supported anywhere Node and the native `better-sqlite3` dependency build successfully. The supported production path is one dedicated **Debian 13 systemd host/LXC** with SQLite on local storage. Do not place SQLite on NFS or run multiple bot replicas against one database.
- This repository is private. The operator must already have repository access or a read-only deploy key; a Discord invite does not grant source access. Never embed a GitHub token in a clone URL.

## Create and install the Discord application

1. In the [Discord Developer Portal](https://discord.com/developers/applications), select **New Application**, enter a name, and select **Create**.
2. Open **Bot**. Under **Privileged Gateway Intents**, enable **Message Content Intent**. Leave **Server Members Intent** and **Presence Intent** off.
3. On **Bot**, disable **Public Bot** for an owner-controlled private bot. If intentionally allowing other server owners to install it, enable **Public Bot** only after reviewing the data-retention implications. Leave **Requires OAuth2 Code Grant** off; this bot does not implement an OAuth2 callback.
4. Open **Installation**. Under **Installation Contexts**, enable **Guild Install** and leave **User Install** off (a user-only install cannot monitor a server). Under **Default Install Settings** → **Guild Install**, add the `bot` and `applications.commands` scopes.
5. Select only these bot permissions: **View Channels**, **Read Message History**, **Send Messages**, **Embed Links**, and **Attach Files**. Do **not** select **Administrator**, **Manage Roles**, **Manage Channels**, **Manage Messages**, or **Mention Everyone**. Category/channel overwrites still control what the bot can read and where it can send evidence.
6. Under **Install Link**, choose **Discord Provided Link**, copy the generated link, open it while signed into Discord, choose **Add to server**, select the guild, and authorize it. If the Installation page does not expose a link, use **OAuth2** → **URL Generator**, select `bot` and `applications.commands`, select the same five permissions, and use the generated URL. The equivalent least-privileged template is below; replace only `APPLICATION_ID`. Permission integer `117760` is exactly the five listed permissions and does not include Administrator.
   ```text
   https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&permissions=117760&scope=bot%20applications.commands
   ```
7. On **Bot**, select **Reset Token** (or copy the token when first creating the bot). Treat it as a password: never paste it into chat, Git, an invite URL, or a shell command.

## Local development

```bash
git clone git@github.com:2xJDubs/discord-deletion-monitor.git
cd discord-deletion-monitor
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
chmod 0600 .env
# Edit .env and replace only DISCORD_TOKEN's placeholder.
pnpm test && pnpm typecheck && pnpm build
pnpm dev
```

`.env` is ignored by Git. Keep the development database at `./data/messages.db` unless there is a reason to override `DATABASE_PATH`. Stop the watcher with Ctrl-C and verify that shutdown completes in the JSON logs.

At each successful Discord connection, the bot registers `/monitor` as a **global application command**. Global registration can take time to propagate. If `/monitor` is absent, confirm the app was installed with `applications.commands`, wait and restart Discord, check for a fresh `client_ready` log, and inspect startup logs for REST registration errors. Do not repeatedly create new applications or grant Administrator as a workaround.

## First-server walkthrough

1. Create a private moderator text channel for evidence. Permit the bot role **View Channel**, **Send Messages**, **Embed Links**, and **Attach Files** there; deny ordinary members access as appropriate.
2. Run `/monitor review-channel` and select that channel.
3. Run `/monitor setup`, select 1–25 text channels, grant the **Deletion Monitor** role **View Channel** where prompted, select **Recheck**, then confirm. Confirmation atomically replaces the monitored-channel list and selects `all` mode.
4. Run `/monitor role exclude` for each trusted administrator/moderator role whose own messages should bypass capture. Review `/monitor settings`; adjust `/monitor mode`, matching rules, retention, administrator monitoring, and attachment capture deliberately.
5. Run `/monitor diagnostics` and resolve every reported permission problem.
6. In a selected non-review channel, post a harmless distinctive message from a non-bot, non-excluded account and delete it. Confirm one red evidence embed appears with the original author's clickable profile, the channel, exact text (or a text file for long content), message ID, deletion time, and any preserved attachments. Confirm nobody was pinged. Do not infer who deleted the message; Discord's deletion event does not provide that identity.

The `/monitor` command requires the invoking member to have **Manage Server**. Configuration and cached evidence are isolated by Discord guild ID.

## Production self-hosting

Follow the copy-paste Debian bootstrap and hardened installer in [`deploy/README.md`](deploy/README.md). The short path after prerequisites and a trusted checkout is:

```bash
pnpm install --frozen-lockfile
pnpm test && pnpm typecheck && pnpm build
sudo ./deploy/install.sh
sudoedit /etc/discord-deletion-monitor.env
sudo chown root:root /etc/discord-deletion-monitor.env /etc/discord-deletion-monitor-backup.env
sudo chmod 0600 /etc/discord-deletion-monitor.env /etc/discord-deletion-monitor-backup.env
sudo systemctl enable --now discord-deletion-monitor
sudo systemctl enable --now discord-deletion-monitor-backup.timer
```

Set `DISCORD_TOKEN=` only in `/etc/discord-deletion-monitor.env`; the backup environment must remain token-free. Systemd reads the root-only environment before dropping privileges. Never put the token directly in a unit file or `Environment=` line.

## Commands

Every command requires **Manage Server** and responds privately. Use `/monitor help` for in-Discord arguments, examples, permissions, and effects.

- `/monitor setup` interactively replaces the monitored-channel list after permission checks and confirmation.
- `/monitor review-channel` sets the private evidence destination.
- `/monitor retention` sets cache lifetime from 1 to 129,600 minutes; the default is 60 minutes.
- `/monitor mode` chooses `all` (default) or `matching`.
- `/monitor administrators` chooses whether administrator messages are monitored (default: ignored).
- `/monitor attachments` chooses whether attachment-only messages are monitored (default: ignored).
- `/monitor keyword add|remove` manages watched phrases.
- `/monitor domain add|remove` manages watched domains.
- `/monitor pattern add|remove` manages built-in scam patterns.
- `/monitor channel include|exclude|remove-include|remove-exclude` controls channel scope.
- `/monitor role exclude|remove-exclusion` manages trusted roles that bypass monitoring.
- `/monitor settings` shows bounded configuration previews.
- `/monitor diagnostics` checks effective monitored-channel and review-channel permissions.
- `/monitor status` shows aggregate storage and pending-delivery counts without message content.
- `/monitor test` checks sample text without saving it.
- `/monitor forget confirm:DELETE` permanently erases this guild's configuration, rules, messages, and attachments.

In `matching` mode, **every message containing a link is cached automatically**, even if the domain is not explicitly listed. Configured keywords, domains, and built-in patterns add further reasons to save a message. Members with Discord's Administrator permission and members with any excluded role are ignored before detection runs.

## Environment configuration

`.env.example` contains every supported variable. Integer values must be positive decimal integers; startup fails instead of silently accepting malformed or out-of-range settings.

| Variable | Default | Accepted range / purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | none | Required bot token; keep secret. |
| `DATABASE_PATH` | `./data/messages.db` | Non-empty local SQLite path. |
| `RETENTION_MINUTES` | `60` | 1–129,600; supersedes legacy `RETENTION_HOURS`. |
| `ATTACHMENT_MAX_FILE_BYTES` | 8 MiB | 1–64 MiB per downloaded file. |
| `ATTACHMENT_MAX_TOTAL_BYTES` | 24 MiB | 1–64 MiB per message and at least the per-file limit. |
| `ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | 10,000 | 1–120,000 milliseconds. |
| `DATABASE_BUSY_TIMEOUT_MS` | 5,000 | 1–60,000 milliseconds. |
| `STORED_ATTACHMENT_MAX_BYTES` | 1 GiB | 1 byte–10 GiB global stored-attachment quota. |
| `CAPTURE_CONCURRENCY` | 2 | 1–16; concurrency × per-message total must not exceed 128 MiB. |
| `CAPTURE_QUEUE_MAX` | 100 | 1–10,000 queued captures. |
| `DELIVERY_RETRY_INTERVAL_MS` | 30,000 | 1–120,000 milliseconds. |
| `DELIVERY_RETRY_BATCH_SIZE` | 50 | 1–1,000 pending records per retry scan. |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | 30,000 | 1–120,000 milliseconds. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

Messages appear in the review channel only if they are deleted. Evidence remains in SQLite until every Discord payload succeeds or retention expires; missing channels and transient failures are retried with persisted exponential backoff, including after process restarts. Atomic delivery leases prevent duplicate immediate/retry workers, and completed payload-batch progress is persisted so partial retries resume without reposting earlier batches. Undeleted cached messages are purged after the per-server retention period. Each payload uses a compact red embed with the capture-time author name/avatar, a non-pinging clickable original-author profile link, channel context, quoted deleted text, match context, message ID, and deletion timestamp. Markdown, mention syntax, controls, and directional text are neutralized for display. Empty text has a readable fallback; exact text that is too long or contains unsafe controls is also delivered as a UTF-8 attachment, and files are split into Discord-safe batches of ten.

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
