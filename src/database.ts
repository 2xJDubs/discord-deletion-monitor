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
  monitor_administrators: boolean;
  monitor_attachments: boolean;
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
  deleted_at?: string | null;
  delivery_attempts?: number;
  next_attempt_at?: string | null;
  last_delivery_error?: string | null;
  delivery_claim_token?: string | null;
  delivery_claimed_until?: string | null;
  delivery_batch_index?: number;
};

export type StoredAttachment = {
  attachment_id: string;
  message_id: string;
  filename: string;
  content_type: string | null;
  size: number;
  source_url: string;
  bytes: Buffer;
};

export type StoredEvidence = { message: StoredMessage; attachments: StoredAttachment[] };

export type SaveResult = {
  storedAttachments: number;
  storedAttachmentBytes: number;
  skippedAttachments: number;
  skippedAttachmentBytes: number;
};

export type GuildStatus = {
  storedMessages: number;
  pendingMessages: number;
  oldestPendingAt: string | null;
  attachments: number;
  attachmentBytes: number;
  attachmentQuotaBytes: number;
};

export type DeleteGuildDataResult = {
  messages: number;
  attachments: number;
  rules: number;
  config: number;
};

export const DATABASE_SCHEMA_VERSION = 2;

export class MessageStore {
  private readonly db: Database.Database;
  private readonly defaultRetentionHours: number;
  private readonly attachmentQuotaBytes: number;
  private closed = false;

  constructor(path: string, defaultRetentionHours: number, options: { busyTimeoutMs?: number; attachmentQuotaBytes?: number } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.defaultRetentionHours = Math.max(1, Math.round(defaultRetentionHours));
    this.attachmentQuotaBytes = options.attachmentQuotaBytes ?? Number.MAX_SAFE_INTEGER;
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    this.db.pragma("journal_mode = WAL");
    const schemaVersion = Number(this.db.pragma("user_version", { simple: true }));
    if (schemaVersion > DATABASE_SCHEMA_VERSION) throw new Error(`Database schema version ${schemaVersion} is newer than supported version ${DATABASE_SCHEMA_VERSION}`);
    this.db.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id TEXT PRIMARY KEY,
        review_channel_id TEXT,
        retention_hours INTEGER NOT NULL DEFAULT ${this.defaultRetentionHours},
        mode TEXT NOT NULL DEFAULT 'matching' CHECK(mode IN ('all', 'matching')),
        monitor_administrators INTEGER NOT NULL DEFAULT 0 CHECK(monitor_administrators IN (0, 1)),
        monitor_attachments INTEGER NOT NULL DEFAULT 0 CHECK(monitor_attachments IN (0, 1))
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
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_delivery_error TEXT,
        delivery_claim_token TEXT,
        delivery_claimed_until TEXT,
        delivery_batch_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT,
        size INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (message_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_guild_created_at ON messages(guild_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
    `);
    this.migrateLegacyGuildConfig();
    this.ensureColumn("guild_config", "retention_hours", `INTEGER NOT NULL DEFAULT ${this.defaultRetentionHours}`);
    this.ensureColumn("guild_config", "mode", "TEXT NOT NULL DEFAULT 'matching'");
    this.ensureColumn("guild_config", "monitor_administrators", "INTEGER NOT NULL DEFAULT 0 CHECK(monitor_administrators IN (0, 1))");
    this.ensureColumn("guild_config", "monitor_attachments", "INTEGER NOT NULL DEFAULT 0 CHECK(monitor_attachments IN (0, 1))");
    this.ensureColumn("messages", "matched_reasons", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("messages", "deleted_at", "TEXT");
    this.ensureColumn("messages", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "next_attempt_at", "TEXT");
    this.ensureColumn("messages", "last_delivery_error", "TEXT");
    this.ensureColumn("messages", "delivery_claim_token", "TEXT");
    this.ensureColumn("messages", "delivery_claimed_until", "TEXT");
    this.ensureColumn("messages", "delivery_batch_index", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(next_attempt_at, delivery_claimed_until, deleted_at)");
    if (schemaVersion < DATABASE_SCHEMA_VERSION) this.db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
    })();
  }

  private migrateLegacyGuildConfig(): void {
    const columns = this.db.prepare("PRAGMA table_info(guild_config)").all() as Array<{ name: string; notnull: number }>;
    if (!columns.some((entry) => entry.name === "review_channel_id" && entry.notnull === 1)) return;
    const names = new Set(columns.map((entry) => entry.name));
    const retention = names.has("retention_hours") ? "retention_hours" : String(this.defaultRetentionHours);
    const mode = names.has("mode") ? "CASE WHEN mode IN ('all', 'matching') THEN mode ELSE 'matching' END" : "'matching'";
    const monitorAdministrators = names.has("monitor_administrators") ? "CASE WHEN monitor_administrators = 1 THEN 1 ELSE 0 END" : "0";
    const monitorAttachments = names.has("monitor_attachments") ? "CASE WHEN monitor_attachments = 1 THEN 1 ELSE 0 END" : "0";
    this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE guild_config RENAME TO guild_config_legacy;
        CREATE TABLE guild_config (
          guild_id TEXT PRIMARY KEY,
          review_channel_id TEXT,
          retention_hours INTEGER NOT NULL DEFAULT ${this.defaultRetentionHours},
          mode TEXT NOT NULL DEFAULT 'matching' CHECK(mode IN ('all', 'matching')),
          monitor_administrators INTEGER NOT NULL DEFAULT 0 CHECK(monitor_administrators IN (0, 1)),
          monitor_attachments INTEGER NOT NULL DEFAULT 0 CHECK(monitor_attachments IN (0, 1))
        );
        INSERT INTO guild_config (guild_id, review_channel_id, retention_hours, mode, monitor_administrators, monitor_attachments)
        SELECT guild_id, review_channel_id, ${retention}, ${mode}, ${monitorAdministrators}, ${monitorAttachments} FROM guild_config_legacy;
        DROP TABLE guild_config_legacy;
      `);
    })();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private ensureGuild(guildId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)").run(guildId);
  }

  save(message: StoredMessage, attachments: StoredAttachment[] = []): SaveResult {
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO messages
        (message_id, guild_id, channel_id, author_id, author_tag, content, attachment_urls, matched_reasons, created_at)
        VALUES (@message_id, @guild_id, @channel_id, @author_id, @author_tag, @content, @attachment_urls, @matched_reasons, @created_at)
        ON CONFLICT(message_id) DO UPDATE SET guild_id=excluded.guild_id, channel_id=excluded.channel_id,
          author_id=excluded.author_id, author_tag=excluded.author_tag, content=excluded.content,
          attachment_urls=excluded.attachment_urls, matched_reasons=excluded.matched_reasons, created_at=excluded.created_at`).run(message);
      this.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(message.message_id);
      let storedBytes = Number((this.db.prepare("SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS total FROM attachments").get() as { total: number }).total);
      const insert = this.db.prepare(`INSERT INTO attachments
        (attachment_id, message_id, filename, content_type, size, source_url, bytes)
        VALUES (@attachment_id, @message_id, @filename, @content_type, @size, @source_url, @bytes)`);
      let storedAttachments = 0;
      let storedAttachmentBytes = 0;
      let skippedAttachments = 0;
      let skippedAttachmentBytes = 0;
      for (const attachment of attachments) {
        if (storedBytes + attachment.bytes.length > this.attachmentQuotaBytes) {
          skippedAttachments += 1;
          skippedAttachmentBytes += attachment.bytes.length;
          continue;
        }
        insert.run(attachment);
        storedBytes += attachment.bytes.length;
        storedAttachments += 1;
        storedAttachmentBytes += attachment.bytes.length;
      }
      return { storedAttachments, storedAttachmentBytes, skippedAttachments, skippedAttachmentBytes };
    })();
  }

  get(messageId: string): StoredMessage | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as StoredMessage | undefined;
  }

  getEvidence(messageId: string): StoredEvidence | undefined {
    const message = this.get(messageId);
    if (!message) return undefined;
    const attachments = this.db.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY attachment_id")
      .all(messageId) as StoredAttachment[];
    return { message, attachments };
  }

  remove(messageId: string): void {
    this.db.prepare("DELETE FROM messages WHERE message_id = ?").run(messageId);
  }

  markDeleted(messageId: string, now: Date = new Date()): boolean {
    const timestamp = now.toISOString();
    return this.db.prepare(`UPDATE messages SET deleted_at = ?, next_attempt_at = ?
      WHERE message_id = ? AND deleted_at IS NULL`)
      .run(timestamp, timestamp, messageId).changes > 0;
  }

  listDuePending(now: Date = new Date(), limit = 50): StoredMessage[] {
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.db.prepare(`SELECT * FROM messages
      WHERE deleted_at IS NOT NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        AND (delivery_claimed_until IS NULL OR delivery_claimed_until <= ?)
      ORDER BY next_attempt_at, message_id LIMIT ?`).all(now.toISOString(), now.toISOString(), boundedLimit) as StoredMessage[];
  }

  claimDelivery(messageId: string, token: string, now: Date = new Date(), leaseMs = 60_000): boolean {
    const timestamp = now.toISOString();
    const claimedUntil = new Date(now.getTime() + Math.max(1, leaseMs)).toISOString();
    return this.db.prepare(`UPDATE messages
      SET delivery_claim_token = ?, delivery_claimed_until = ?
      WHERE message_id = ? AND deleted_at IS NOT NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        AND julianday(COALESCE(deleted_at, created_at)) > julianday(?) - (COALESCE(
          (SELECT retention_hours FROM guild_config WHERE guild_id = messages.guild_id), ?
        ) / 24.0)
        AND (delivery_claimed_until IS NULL OR delivery_claimed_until <= ?)`)
      .run(token, claimedUntil, messageId, timestamp, timestamp, this.defaultRetentionHours, timestamp).changes === 1;
  }

  renewDeliveryClaim(messageId: string, token: string, now: Date = new Date(), leaseMs = 60_000): boolean {
    const timestamp = now.toISOString();
    const claimedUntil = new Date(now.getTime() + Math.max(1, leaseMs)).toISOString();
    return this.db.prepare(`UPDATE messages SET delivery_claimed_until = ?
      WHERE message_id = ? AND delivery_claim_token = ? AND delivery_claimed_until > ?
        AND julianday(COALESCE(deleted_at, created_at)) > julianday(?) - (COALESCE(
          (SELECT retention_hours FROM guild_config WHERE guild_id = messages.guild_id), ?
        ) / 24.0)`)
      .run(claimedUntil, messageId, token, timestamp, timestamp, this.defaultRetentionHours).changes === 1;
  }

  isClaimDeliverable(messageId: string, token: string, now: Date = new Date()): boolean {
    const timestamp = now.toISOString();
    return this.db.prepare(`SELECT 1 FROM messages
      WHERE message_id = ? AND delivery_claim_token = ? AND delivery_claimed_until > ?
        AND julianday(COALESCE(deleted_at, created_at)) > julianday(?) - (COALESCE(
          (SELECT retention_hours FROM guild_config WHERE guild_id = messages.guild_id), ?
        ) / 24.0)`).get(messageId, token, timestamp, timestamp, this.defaultRetentionHours) !== undefined;
  }

  advanceDeliveryBatch(messageId: string, token: string, nextBatchIndex: number): boolean {
    return this.db.prepare(`UPDATE messages SET delivery_batch_index = ?
      WHERE message_id = ? AND delivery_claim_token = ? AND delivery_batch_index < ?`)
      .run(nextBatchIndex, messageId, token, nextBatchIndex).changes === 1;
  }

  removeClaimed(messageId: string, token: string): boolean {
    return this.db.prepare("DELETE FROM messages WHERE message_id = ? AND delivery_claim_token = ?")
      .run(messageId, token).changes === 1;
  }

  scheduleRetry(messageId: string, error: unknown, now: Date = new Date(), options: { baseMs?: number; maxMs?: number; claimToken?: string } = {}): boolean {
    const current = this.get(messageId);
    if (!current?.deleted_at || (options.claimToken && current.delivery_claim_token !== options.claimToken)) return false;
    const attempts = (current.delivery_attempts ?? 0) + 1;
    const baseMs = options.baseMs ?? 5_000;
    const maxMs = options.maxMs ?? 15 * 60_000;
    const delay = Math.min(maxMs, baseMs * (2 ** Math.min(attempts - 1, 30)));
    const next = new Date(now.getTime() + delay).toISOString();
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const result = this.db.prepare(`UPDATE messages SET delivery_attempts = ?, next_attempt_at = ?, last_delivery_error = ?,
      delivery_claim_token = NULL, delivery_claimed_until = NULL
      WHERE message_id = ? AND (? IS NULL OR delivery_claim_token = ?)`)
      .run(attempts, next, detail, messageId, options.claimToken ?? null, options.claimToken ?? null);
    return result.changes > 0;
  }

  purgeExpired(now: Date): number {
    return this.db.prepare(`DELETE FROM messages
      WHERE julianday(COALESCE(deleted_at, created_at)) <= julianday(?) - (COALESCE(
        (SELECT retention_hours FROM guild_config WHERE guild_id = messages.guild_id), ?
      ) / 24.0)`).run(now.toISOString(), this.defaultRetentionHours).changes;
  }

  getConfig(guildId: string): GuildConfig {
    this.ensureGuild(guildId);
    const row = this.db.prepare("SELECT * FROM guild_config WHERE guild_id = ?").get(guildId) as Omit<GuildConfig, "monitor_administrators" | "monitor_attachments"> & { monitor_administrators: number; monitor_attachments: number };
    return { ...row, monitor_administrators: row.monitor_administrators === 1, monitor_attachments: row.monitor_attachments === 1 };
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

  setMonitorAdministrators(guildId: string, enabled: boolean): void {
    this.ensureGuild(guildId);
    this.db.prepare("UPDATE guild_config SET monitor_administrators = ? WHERE guild_id = ?").run(enabled ? 1 : 0, guildId);
  }

  setMonitorAttachments(guildId: string, enabled: boolean): void {
    this.ensureGuild(guildId);
    this.db.prepare("UPDATE guild_config SET monitor_attachments = ? WHERE guild_id = ?").run(enabled ? 1 : 0, guildId);
  }

  addRule(guildId: string, kind: RuleKind, value: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO rules (guild_id, kind, value) VALUES (?, ?, ?)").run(guildId, kind, value).changes > 0;
  }

  removeRule(guildId: string, kind: RuleKind, value: string): boolean {
    return this.db.prepare("DELETE FROM rules WHERE guild_id = ? AND kind = ? AND value = ?").run(guildId, kind, value).changes > 0;
  }

  listRules(guildId: string, kind: RuleKind): string[] {
    const rows = this.db.prepare("SELECT value FROM rules WHERE guild_id = ? AND kind = ? ORDER BY value").all(guildId, kind) as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }

  getPragmas(): { foreignKeys: boolean; journalMode: string; busyTimeoutMs: number } {
    return {
      foreignKeys: this.db.pragma("foreign_keys", { simple: true }) === 1,
      journalMode: String(this.db.pragma("journal_mode", { simple: true })),
      busyTimeoutMs: Number(this.db.pragma("busy_timeout", { simple: true })),
    };
  }

  getGuildStatus(guildId: string): GuildStatus {
    const messageRow = this.db.prepare(`SELECT
        COUNT(*) AS storedMessages,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS pendingMessages,
        MIN(CASE WHEN deleted_at IS NOT NULL THEN deleted_at ELSE NULL END) AS oldestPendingAt
      FROM messages WHERE guild_id = ?`).get(guildId) as { storedMessages: number; pendingMessages: number | null; oldestPendingAt: string | null };
    const attachmentRow = this.db.prepare(`SELECT
        COUNT(*) AS attachments,
        COALESCE(SUM(LENGTH(a.bytes)), 0) AS attachmentBytes
      FROM attachments a JOIN messages m ON m.message_id = a.message_id WHERE m.guild_id = ?`).get(guildId) as { attachments: number; attachmentBytes: number };
    return {
      storedMessages: messageRow.storedMessages,
      pendingMessages: messageRow.pendingMessages ?? 0,
      oldestPendingAt: messageRow.oldestPendingAt ?? null,
      attachments: attachmentRow.attachments,
      attachmentBytes: Number(attachmentRow.attachmentBytes),
      attachmentQuotaBytes: this.attachmentQuotaBytes,
    };
  }

  deleteGuildData(guildId: string): DeleteGuildDataResult {
    return this.db.transaction(() => {
      const attachments = this.db.prepare(`DELETE FROM attachments
        WHERE message_id IN (SELECT message_id FROM messages WHERE guild_id = ?)`).run(guildId).changes;
      const messages = this.db.prepare("DELETE FROM messages WHERE guild_id = ?").run(guildId).changes;
      const rules = this.db.prepare("DELETE FROM rules WHERE guild_id = ?").run(guildId).changes;
      const config = this.db.prepare("DELETE FROM guild_config WHERE guild_id = ?").run(guildId).changes;
      return { messages, attachments, rules, config };
    })();
  }

  countAttachments(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM attachments").get() as { count: number }).count);
  }

  async backup(destination: string): Promise<void> {
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
  }

  close(): boolean {
    if (this.closed) return false;
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.closed = true;
    return true;
  }
}

export type BackupSource = { backup(destination: string): Promise<void>; close(): void };

/** Opens an existing source read-only; this path intentionally performs no schema migration or DDL. */
export function openBackupSource(path: string, busyTimeoutMs = 5_000): BackupSource {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const version = Number(db.pragma("user_version", { simple: true }));
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new Error(`Backup source schema version ${version} is newer than supported version ${DATABASE_SCHEMA_VERSION}`);
    }
    return {
      backup: async (destination) => { await db.backup(destination); },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
