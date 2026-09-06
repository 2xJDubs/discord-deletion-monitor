# Data retention and privacy

Discord Deletion Monitor temporarily processes message content for moderation evidence. Server owners should disclose this behavior to members where required by their rules or local law.

## Stored data

For messages selected by the configured monitoring policy, the bot may store:

- Discord message, guild, channel, and author identifiers
- the author's Discord tag at capture time
- message text and detection reasons
- posting timestamp
- downloaded attachment filename, media type, size, and bytes, subject to configured limits

The Discord token is never stored in SQLite.

## Retention

Each guild controls retention with `/monitor retention`. The default is 60 minutes, and the command allows 1 through 129,600 minutes (90 days). The purge worker runs once per minute. Evidence is deleted when either:

1. it is successfully delivered to the configured review channel after message deletion, or
2. its retention period expires.

Evidence is retained when delivery cannot be confirmed, including when the review channel is missing, inaccessible, or temporarily unavailable. Delivery ownership, retry timing, and completed payload-batch progress are persisted in SQLite so restart recovery does not intentionally duplicate completed batches. Retention expiry remains the upper bound.

## Attachment limits

Operators can cap attachment downloads per file and per message, set a network timeout, bound capture concurrency and queue depth, and enforce a global stored-byte quota. Attachments that exceed limits or fail to download are logged and skipped; queue overflow still preserves message text. Choose limits that fit the LXC storage budget and Discord upload limits.

## Backups

Online SQLite backups contain the same sensitive evidence as the live database. The supplied daily timer deletes regular `*.db` files matching GNU `find -daystart -mtime +14`: age is measured from the start of today and `+14` means more than 14 complete rounded calendar-day buckets. This retains approximately 15 daily backups, with boundary timing sometimes retaining one extra. Proxmox or off-host backups should use an explicitly chosen retention period and equivalent access controls.

With the default 1 GiB stored-attachment quota, the live database plus approximately 15 full daily backups can consume about 16 GiB before text, SQLite overhead, releases, the OS, logs, and free-space headroom. The production guide therefore recommends a 24 GiB disk (about 21 GiB expected capacity plus margin). Operators choosing an 8 GiB container must explicitly configure about three local backups and tested off-LXC copies; the installer does not silently reduce message or backup retention.

## Access and deletion

Restrict the Discord review channel, LXC shell, SQLite database, and backups to trusted administrators. Production environment files are `root:root` mode `0600`; systemd reads them before starting the unprivileged process. `/monitor forget confirm:DELETE` atomically removes one guild's configuration, rules, messages, and attachments.
