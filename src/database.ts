import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type StoredMessage = {
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  author_tag: string;
  content: string;
  attachment_urls: string;
  created_at: string;
};

export class MessageStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        review_channel_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_tag TEXT NOT NULL,
        content TEXT NOT NULL,
        attachment_urls TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `);
  }

  save(message: StoredMessage): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages
      (message_id, guild_id, channel_id, author_id, author_tag, content, attachment_urls, created_at)
      VALUES (@message_id, @guild_id, @channel_id, @author_id, @author_tag, @content, @attachment_urls, @created_at)
    `).run(message);
  }

  get(messageId: string): StoredMessage | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId) as StoredMessage | undefined;
  }

  remove(messageId: string): void {
    this.db.prepare("DELETE FROM messages WHERE message_id = ?").run(messageId);
  }

  purgeOlderThan(isoDate: string): number {
    return this.db.prepare("DELETE FROM messages WHERE created_at < ?").run(isoDate).changes;
  }

  setReviewChannel(guildId: string, channelId: string): void {
    this.db.prepare(`
      INSERT INTO guild_config (guild_id, review_channel_id) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET review_channel_id = excluded.review_channel_id
    `).run(guildId, channelId);
  }

  getReviewChannel(guildId: string): string | undefined {
    const row = this.db.prepare("SELECT review_channel_id FROM guild_config WHERE guild_id = ?")
      .get(guildId) as { review_channel_id: string } | undefined;
    return row?.review_channel_id;
  }
}
