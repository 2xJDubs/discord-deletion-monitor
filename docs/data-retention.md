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

Each guild controls retention with `/monitor retention`. The default is 336 hours (14 days), and the command allows 1 through 2,160 hours. Evidence is deleted when either:

1. it is successfully delivered to the configured review channel after message deletion, or
2. its retention period expires.

Evidence is retained when delivery cannot be confirmed, including when the review channel is missing, inaccessible, or temporarily unavailable. Delivery ownership, retry timing, and completed payload-batch progress are persisted in SQLite so restart recovery does not intentionally duplicate completed batches. Retention expiry remains the upper bound.

## Attachment limits

Operators can cap attachment downloads per file and per message, set a network timeout, bound capture concurrency and queue depth, and enforce a global stored-byte quota. Attachments that exceed limits or fail to download are logged and skipped; queue overflow still preserves message text. Choose limits that fit the LXC storage budget and Discord upload limits.

## Backups

Online SQLite backups contain the same sensitive evidence as the live database. The supplied timer retains local backups for 14 days. Proxmox or off-host backups should use an explicitly chosen retention period and equivalent access controls.

## Access and deletion

Restrict the Discord review channel, LXC shell, SQLite database, and backups to trusted administrators. Removing a guild's configuration and evidence is currently an operator database task; stop the service and take a backup before manual maintenance.
