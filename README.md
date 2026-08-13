# Discord Deletion Monitor

A multi-server Discord bot that caches suspicious messages and sends evidence to each server's private review channel only when a cached message is deleted.

## Setup

1. Create a Discord application and bot in the Developer Portal.
2. Enable the **Message Content Intent**.
3. Invite the bot with `View Channels`, `Read Message History`, `Send Messages`, and `Attach Files` permissions. Do not grant Administrator.
4. Copy `.env.example` to `.env` and add the bot token.
5. Run `pnpm install`, then `pnpm dev`.
6. Run `/monitor review-channel` in each server and select its private moderator channel.
7. Run `/monitor role exclude` for every trusted admin or moderator role whose messages should be ignored.

The `/monitor` command requires `Manage Server`. Configuration and cached evidence are isolated by Discord guild ID.

## Commands

- `/monitor review-channel` sets the private evidence destination.
- `/monitor retention` sets cache lifetime from 1 to 2,160 hours.
- `/monitor mode` chooses `matching` (default) or `all`.
- `/monitor keyword add|remove` manages watched phrases.
- `/monitor domain add|remove` manages watched domains.
- `/monitor pattern add|remove` manages built-in scam patterns.
- `/monitor channel include|exclude|remove-include|remove-exclude` controls channel scope.
- `/monitor role exclude|remove-exclusion` manages trusted roles that bypass monitoring.
- `/monitor settings` shows the server's configuration.
- `/monitor test` checks sample text without saving it.

In `matching` mode, **every message containing a link is cached automatically**, even if the domain is not explicitly listed. Configured keywords, domains, and built-in patterns add further reasons to save a message. Members with Discord's Administrator permission and members with any excluded role are ignored before detection runs.

Messages appear in the review channel only if they are deleted. Undeleted cached messages are purged after the per-server retention period. Copied text uses disabled mentions.

Attachment URLs may expire after deletion. A production deployment should download attachment bytes at message creation and apply a documented retention policy.
