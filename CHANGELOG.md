# Changelog

## 0.3.0

- Present deleted-message evidence in compact red Discord embeds with capture-time author avatars, linked original-author profiles, channel context, quoted text, message IDs, and deletion timestamps.
- Neutralize author/content Markdown, controls, directional text, and mentions while preserving exact long text and attachments in bounded files and batches.
- Add backward-compatible SQLite schema version 6 for immutable author-avatar presentation data and durable evidence batch-plan compatibility.
- Require and diagnose the least-privileged **Embed Links** permission for review channels.
- Add end-to-end local and Debian/systemd self-hosting, Discord Developer Portal, first-server, command-registration, persistence, backup, restart, timer, and log verification guidance.
