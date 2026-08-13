import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type MonitorMode = "all" | "matching";
export type RuleKind = "keyword" | "domain" | "pattern" | "include_channel" | "exclude_channel" | "exclude_role";

export type GuildConfig = {
  guild_id: string;
  review_channel_id: string | null;
  retention_hours: number;
  mode: MonitorMode;
};

export type StoredMessage = {
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  author_tag: string;
  content: string;
  attachment_urls: string;
  matched_reasons: string;
  created_at: string;
};

export class MessageStore {
  private readonly db: Database.Database;

  constructor(path: string, defaultRetentionHours: number) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        review_channel_id TEXT,
        retention_hours INTEGER NOT NULL DEFAULT ${Math.max(1, Math.round(defaultRetentionHours))},
        mode TEXT NOT NULL DEFAULT 'matching' CHECK(mode IN ('all', 'matching'))
      );
      CREATE TABLE IF NOT EXISTS rules (
        guild_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (guild_id, kind, value)
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_tag TEXT NOT NULL,
        content TEXT NOT NULL,
        attachment_urls TEXT NOT NULL,
        matched_reasons TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_guild_created_at ON messages(guild_id, created_at);
    `);
    this.migrateLegacyGuildConfig(defaultRetentionHours);
    this.ensureColumn("guild_config", "retention_hours", `INTEGER NOT NULL DEFAULT ${Math.max(1, Math.round(defaultRetentionHours))}`);
    this.ensureColumn("guild_config", "mode", "TEXT NOT NULL DEFAULT 'matching'");
    this.ensureColumn("messages", "matched_reasons", "TEXT NOT NULL DEFAULT '[]'");
  }

  private migrateLegacyGuildConfig(defaultRetentionHours: number): void {
    const columns = this.db.prepare("PRAGMA table_info(guild_config)").all() as Array<{ name: string; notnull: number }>;
    if (!columns.some((entry) => entry.name === "review_channel_id" && entry.notnull === 1)) return;
    const retention = Math.max(1, Math.round(defaultRetentionHours));
    this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE guild_config RENAME TO guild_config_legacy;
        CREATE TABLE guild_config (
          guild_id TEXT PRIMARY KEY,
          review_channel_id TEXT,
          retention_hours INTEGER NOT NULL DEFAULT ${retention},
          mode TEXT NOT NULL DEFAULT 'matching' CHECK(mode IN ('all', 'matching'))
        );
        INSERT INTO guild_config (guild_id, review_channel_id)
        SELECT guild_id, review_channel_id FROM guild_config_legacy;
        DROP TABLE guild_config_legacy;
      `);
    })();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private ensureGuild(guildId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)").run(guildId);
  }

  save(message: StoredMessage): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages
      (message_id, guild_id, channel_id, author_id, author_tag, content, attachment_urls, matched_reasons, created_at)
      VALUES (@message_id, @guild_id, @channel_id, @author_id, @author_tag, @content, @attachment_urls, @matched_reasons, @created_at)
    `).run(message);
  }

  get(messageId: string): StoredMessage | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as StoredMessage | undefined;
  }

  remove(messageId: string): void {
    this.db.prepare("DELETE FROM messages WHERE message_id = ?").run(messageId);
  }

  purgeExpired(now: Date): number {
    return this.db.prepare(`
      DELETE FROM messages
      WHERE julianday(created_at) < julianday(?) - (COALESCE(
        (SELECT retention_hours FROM guild_config WHERE guild_id = messages.guild_id), 336
      ) / 24.0)
    `).run(now.toISOString()).changes;
  }

  getConfig(guildId: string): GuildConfig {
    this.ensureGuild(guildId);
    return this.db.prepare("SELECT * FROM guild_config WHERE guild_id = ?").get(guildId) as GuildConfig;
  }

  setReviewChannel(guildId: string, channelId: string): void {
    this.ensureGuild(guildId);
    this.db.prepare("UPDATE guild_config SET review_channel_id = ? WHERE guild_id = ?").run(channelId, guildId);
  }

  setRetention(guildId: string, hours: number): void {
    this.ensureGuild(guildId);
    this.db.prepare("UPDATE guild_config SET retention_hours = ? WHERE guild_id = ?").run(hours, guildId);
  }

  setMode(guildId: string, mode: MonitorMode): void {
    this.ensureGuild(guildId);
    this.db.prepare("UPDATE guild_config SET mode = ? WHERE guild_id = ?").run(mode, guildId);
  }

  addRule(guildId: string, kind: RuleKind, value: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO rules (guild_id, kind, value) VALUES (?, ?, ?)")
      .run(guildId, kind, value).changes > 0;
  }

  removeRule(guildId: string, kind: RuleKind, value: string): boolean {
    return this.db.prepare("DELETE FROM rules WHERE guild_id = ? AND kind = ? AND value = ?")
      .run(guildId, kind, value).changes > 0;
  }

  listRules(guildId: string, kind: RuleKind): string[] {
    const rows = this.db.prepare("SELECT value FROM rules WHERE guild_id = ? AND kind = ? ORDER BY value")
      .all(guildId, kind) as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }
}
