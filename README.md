# Discord Deletion Monitor

A multi-server Discord bot that temporarily caches messages and sends evidence to each server's private review channel only when a message is deleted.

## Setup

1. Create a Discord application and bot in the Developer Portal.
2. Enable the **Message Content Intent**.
3. Invite the bot with `View Channels`, `Read Message History`, `Send Messages`, and `Attach Files` permissions. Do not grant Administrator.
4. Copy `.env.example` to `.env` and add the bot token.
5. Run `pnpm install`, then `pnpm dev`.
6. In each server, run `/deletion-monitor` and select its private moderator review channel.

Messages that are not deleted expire from SQLite after `RETENTION_DAYS`. Data is isolated by Discord guild ID, and copied content cannot trigger mentions.

## Current scope

- Supports multiple Discord servers from one bot process.
- Captures message text and attachment URLs at posting time.
- Reports cached evidence upon deletion.
- Automatically purges ordinary, undeleted messages.

Attachment URLs may expire after deletion. A production deployment should download attachment bytes at message creation and apply a documented retention policy.
