import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageStore, type StoredAttachment, type StoredMessage } from "./database.js";

const dirs: string[] = [];
function tempPath(name = "messages.db"): string {
  const dir = mkdtempSync(join(tmpdir(), "deletion-monitor-"));
  dirs.push(dir);
  return join(dir, name);
}
function message(id = "m1", createdAt = new Date().toISOString()): StoredMessage {
  return {
    message_id: id, guild_id: "g1", channel_id: "c1", author_id: "u1",
    author_tag: "user", content: "hello", attachment_urls: "[]",
    matched_reasons: "[]", created_at: createdAt,
  };
}
const attachment: StoredAttachment = {
  attachment_id: "a1", message_id: "m1", filename: "proof.txt",
  content_type: "text/plain", size: 5, source_url: "https://cdn.test/proof.txt",
  bytes: Buffer.from("hello"),
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("MessageStore", () => {
  it("migrates the complete origin schema and preserves its data", () => {
    const path = tempPath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE guild_config (guild_id TEXT PRIMARY KEY, review_channel_id TEXT NOT NULL);
      CREATE TABLE rules (guild_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (guild_id, kind, value));
      CREATE TABLE messages (message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, author_tag TEXT NOT NULL, content TEXT NOT NULL, attachment_urls TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO guild_config VALUES ('g1', 'review');
      INSERT INTO rules VALUES ('g1', 'keyword', 'urgent');
      INSERT INTO messages VALUES ('m1', 'g1', 'c1', 'u1', 'user', 'legacy', '[]', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();
    const store = new MessageStore(path, 336);
    expect(store.getConfig("g1").review_channel_id).toBe("review");
    expect(store.listRules("g1", "keyword")).toEqual(["urgent"]);
    expect(store.get("m1")).toMatchObject({ content: "legacy", deleted_at: null, delivery_attempts: 0 });
    store.close();
  });

  it("version-migrates legacy guild config without resetting retention or mode", () => {
    const path = tempPath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE guild_config (
        guild_id TEXT PRIMARY KEY,
        review_channel_id TEXT NOT NULL,
        retention_hours INTEGER NOT NULL DEFAULT 336,
        mode TEXT NOT NULL DEFAULT 'matching'
      );
      INSERT INTO guild_config VALUES ('custom', 'review', 72, 'all');
      INSERT INTO guild_config VALUES ('defaults', 'review-2', 336, 'matching');
    `);
    legacy.close();

    const store = new MessageStore(path, 168);
    expect(store.getConfig("custom")).toMatchObject({ retention_hours: 72, mode: "all" });
    expect(store.getConfig("defaults")).toMatchObject({ retention_hours: 336, mode: "matching" });
    store.close();

    const migrated = new Database(path, { readonly: true });
    expect(migrated.pragma("user_version", { simple: true })).toBeGreaterThan(0);
    migrated.close();
  });

  it("defaults monitoring flags off and persists explicit guild configuration", () => {
    const path = tempPath();
    let store = new MessageStore(path, 336);
    expect(store.getConfig("g1")).toMatchObject({ monitor_administrators: false, monitor_attachments: false });
    store.setMonitorAdministrators("g1", true);
    store.setMonitorAttachments("g1", true);
    store.close();
    store = new MessageStore(path, 336);
    expect(store.getConfig("g1")).toMatchObject({ monitor_administrators: true, monitor_attachments: true });
    store.close();
  });

  it("marks a deletion exactly once for duplicate gateway events", () => {
    const store = new MessageStore(tempPath(), 336);
    store.save(message());
    expect(store.markDeleted("m1", new Date("2026-01-01T00:00:00Z"))).toBe(true);
    expect(store.markDeleted("m1", new Date("2026-01-01T00:00:01Z"))).toBe(false);
    expect(store.get("m1")?.deleted_at).toBe("2026-01-01T00:00:00.000Z");
    store.close();
  });

  it("persists deletion state and recovers bounded due work after restart", () => {
    const path = tempPath();
    let store = new MessageStore(path, 336);
    for (const id of ["m1", "m2", "m3"]) { store.save(message(id)); store.markDeleted(id, new Date("2026-01-02T00:00:00Z")); }
    store.close();
    store = new MessageStore(path, 336);
    expect(store.listDuePending(new Date("2026-01-02T00:00:00Z"), 2).map((item) => item.message_id)).toEqual(["m1", "m2"]);
    store.close();
  });

  it("atomically leases due delivery across processes and reclaims only after expiry", () => {
    const path = tempPath();
    const first = new MessageStore(path, 336);
    first.save(message());
    first.markDeleted("m1", new Date("2026-01-01T00:00:00Z"));
    const second = new MessageStore(path, 336);
    expect(first.claimDelivery("m1", "worker-a", new Date("2026-01-01T00:00:00Z"), 1_000)).toBe(true);
    expect(second.claimDelivery("m1", "worker-b", new Date("2026-01-01T00:00:00.500Z"), 1_000)).toBe(false);
    expect(second.listDuePending(new Date("2026-01-01T00:00:00.500Z"), 10)).toEqual([]);
    first.close();
    expect(second.claimDelivery("m1", "worker-b", new Date("2026-01-01T00:00:01.001Z"), 1_000)).toBe(true);
    expect(second.get("m1")).toMatchObject({ delivery_claim_token: "worker-b", delivery_claimed_until: "2026-01-01T00:00:02.001Z" });
    second.close();
  });

  it("renews only a live lease still owned by the same token", () => {
    const path = tempPath();
    const first = new MessageStore(path, 336);
    first.save(message());
    first.markDeleted("m1", new Date("2026-01-01T00:00:00Z"));
    const second = new MessageStore(path, 336);
    expect(first.claimDelivery("m1", "worker-a", new Date("2026-01-01T00:00:00Z"), 1_000)).toBe(true);
    expect(first.renewDeliveryClaim("m1", "worker-a", new Date("2026-01-01T00:00:00.500Z"), 1_000)).toBe(true);
    expect(first.get("m1")?.delivery_claimed_until).toBe("2026-01-01T00:00:01.500Z");
    expect(first.renewDeliveryClaim("m1", "wrong-token", new Date("2026-01-01T00:00:00.750Z"), 1_000)).toBe(false);
    expect(second.claimDelivery("m1", "worker-b", new Date("2026-01-01T00:00:01.501Z"), 1_000)).toBe(true);
    expect(first.renewDeliveryClaim("m1", "worker-a", new Date("2026-01-01T00:00:01.502Z"), 1_000)).toBe(false);
    first.close();
    second.close();
  });

  it("fences claims and pre-send delivery at the retention boundary across stores", () => {
    const path = tempPath();
    const first = new MessageStore(path, 24);
    const second = new MessageStore(path, 24);
    first.setRetention("g1", 1);
    first.save(message("m1", "2026-01-01T00:00:00Z"));
    first.markDeleted("m1", new Date("2026-01-01T00:00:00Z"));
    expect(first.claimDelivery("m1", "worker-a", new Date("2026-01-01T00:59:59Z"), 120_000)).toBe(true);
    expect(first.isClaimDeliverable("m1", "worker-a", new Date("2026-01-01T00:59:59Z"))).toBe(true);
    expect(first.renewDeliveryClaim("m1", "worker-a", new Date("2026-01-01T01:00:00Z"), 120_000)).toBe(false);
    expect(first.isClaimDeliverable("m1", "worker-a", new Date("2026-01-01T01:00:00Z"))).toBe(false);
    expect(second.claimDelivery("m1", "worker-b", new Date("2026-01-01T01:00:00Z"), 120_000)).toBe(false);
    expect(second.purgeExpired(new Date("2026-01-01T01:00:00Z"))).toBe(1);
    first.close();
    second.close();
  });

  it("releases its delivery claim when scheduling a retry", () => {
    const store = new MessageStore(tempPath(), 336);
    store.save(message());
    store.markDeleted("m1", new Date("2026-01-01T00:00:00Z"));
    store.claimDelivery("m1", "worker-a", new Date("2026-01-01T00:00:00Z"), 60_000);
    expect(store.scheduleRetry("m1", new Error("temporary"), new Date("2026-01-01T00:00:00Z"), { baseMs: 1_000, claimToken: "worker-a" })).toBe(true);
    expect(store.get("m1")).toMatchObject({ delivery_claim_token: null, delivery_claimed_until: null, next_attempt_at: "2026-01-01T00:00:01.000Z" });
    store.close();
  });

  it("persists claimed batch progress across upsert and process restart", () => {
    const path = tempPath();
    let store = new MessageStore(path, 336);
    store.save(message());
    store.markDeleted("m1", new Date("2026-01-01T00:00:00Z"));
    store.claimDelivery("m1", "worker-a", new Date("2026-01-01T00:00:00Z"), 60_000);
    expect(store.advanceDeliveryBatch("m1", "worker-a", 1)).toBe(true);
    store.save({ ...message(), content: "edited snapshot" });
    expect(store.get("m1")).toMatchObject({ delivery_batch_index: 1, delivery_claim_token: "worker-a", deleted_at: "2026-01-01T00:00:00.000Z" });
    store.close();
    store = new MessageStore(path, 336);
    expect(store.get("m1")?.delivery_batch_index).toBe(1);
    store.close();
  });

  it("records exponential capped retry metadata and removes only on success", () => {
    const store = new MessageStore(tempPath(), 336);
    store.save(message());
    store.markDeleted("m1", new Date("2026-01-01T00:00:00Z"));
    store.scheduleRetry("m1", new Error("no permission"), new Date("2026-01-01T00:00:00Z"), { baseMs: 1000, maxMs: 2500 });
    expect(store.get("m1")).toMatchObject({ delivery_attempts: 1, next_attempt_at: "2026-01-01T00:00:01.000Z", last_delivery_error: "no permission" });
    store.scheduleRetry("m1", "again", new Date("2026-01-01T00:00:01Z"), { baseMs: 2000, maxMs: 2500 });
    expect(store.get("m1")).toMatchObject({ delivery_attempts: 2, next_attempt_at: "2026-01-01T00:00:03.500Z" });
    store.remove("m1");
    expect(store.get("m1")).toBeUndefined();
    store.close();
  });

  it("expires undeleted evidence from creation and deleted evidence from deletion time", () => {
    const store = new MessageStore(tempPath(), 1);
    store.save(message("old", "2026-01-01T00:00:00Z"));
    store.save(message("deleted", "2026-01-01T00:00:00Z"));
    store.markDeleted("deleted", new Date("2026-01-02T00:00:00Z"));
    expect(store.purgeExpired(new Date("2026-01-02T00:30:00Z"))).toBe(1);
    expect(store.get("deleted")).toBeDefined();
    expect(store.purgeExpired(new Date("2026-01-02T01:01:00Z"))).toBe(1);
    store.close();
  });
  it("enables foreign keys, WAL, and the configured busy timeout", () => {
    const path = tempPath();
    const store = new MessageStore(path, 336, { busyTimeoutMs: 4321 });
    expect(store.getPragmas()).toMatchObject({ foreignKeys: true, journalMode: "wal", busyTimeoutMs: 4321 });
    store.close();
  });

  it("stores and retrieves durable attachment metadata and bytes", () => {
    const store = new MessageStore(tempPath(), 336);
    store.save(message(), [attachment]);
    const evidence = store.getEvidence("m1");
    expect(evidence?.message.content).toBe("hello");
    expect(evidence?.attachments).toHaveLength(1);
    expect(evidence?.attachments[0]).toMatchObject({ filename: "proof.txt", content_type: "text/plain", size: 5 });
    expect(evidence?.attachments[0].bytes.equals(Buffer.from("hello"))).toBe(true);
    store.close();
  });

  it("admits stored attachments only within the configured global byte quota", () => {
    const store = new MessageStore(tempPath(), 336, { attachmentQuotaBytes: 6 });
    const second = { ...attachment, attachment_id: "a2", size: 2, bytes: Buffer.from("hi") };
    expect(store.save(message(), [attachment, second])).toEqual({
      storedAttachments: 1, storedAttachmentBytes: 5, skippedAttachments: 1, skippedAttachmentBytes: 2,
    });
    expect(store.getEvidence("m1")?.attachments.map((item) => item.attachment_id)).toEqual(["a1"]);
    expect(store.save(message("m2"), [{ ...second, message_id: "m2" }])).toEqual({
      storedAttachments: 0, storedAttachmentBytes: 0, skippedAttachments: 1, skippedAttachmentBytes: 2,
    });
    expect(store.getEvidence("m2")?.attachments).toHaveLength(0);
    store.close();
  });

  it("reports guild status and atomically deletes only that guild's durable data", () => {
    const path = tempPath();
    const store = new MessageStore(path, 336, { attachmentQuotaBytes: 100 });
    store.setReviewChannel("g1", "review");
    store.addRule("g1", "keyword", "urgent");
    store.save(message("m1", "2026-01-01T00:00:00Z"), [attachment]);
    store.save(message("m2", "2026-01-02T00:00:00Z"));
    store.markDeleted("m1", new Date("2026-01-03T00:00:00Z"));
    store.save({ ...message("other"), guild_id: "g2" });

    expect(store.getGuildStatus("g1")).toEqual({
      storedMessages: 2,
      pendingMessages: 1,
      oldestPendingAt: "2026-01-03T00:00:00.000Z",
      attachments: 1,
      attachmentBytes: 5,
      attachmentQuotaBytes: 100,
    });
    expect(store.deleteGuildData("g1")).toEqual({ messages: 2, attachments: 1, rules: 1, config: 1 });
    expect(store.get("m1")).toBeUndefined();
    expect(store.get("other")).toBeDefined();
    expect(store.listRules("g1", "keyword")).toEqual([]);
    expect(store.deleteGuildData("g1")).toEqual({ messages: 0, attachments: 0, rules: 0, config: 0 });
    store.close();
  });

  it("migrates an existing database by adding the attachments table", () => {
    const path = tempPath();
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE messages (message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, author_tag TEXT NOT NULL, content TEXT NOT NULL, attachment_urls TEXT NOT NULL, matched_reasons TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)");
    legacy.close();
    const store = new MessageStore(path, 336);
    store.save(message(), [attachment]);
    expect(store.getEvidence("m1")?.attachments[0].filename).toBe("proof.txt");
    store.close();
  });

  it("cascade-deletes attachments when evidence is removed", () => {
    const store = new MessageStore(tempPath(), 336);
    store.save(message(), [attachment]);
    store.remove("m1");
    expect(store.getEvidence("m1")).toBeUndefined();
    expect(store.countAttachments()).toBe(0);
    store.close();
  });

  it("cascade-deletes attachments when evidence expires", () => {
    const store = new MessageStore(tempPath(), 1);
    store.save(message("m1", new Date("2020-01-01T00:00:00Z").toISOString()), [attachment]);
    expect(store.purgeExpired(new Date("2020-01-02T00:00:00Z"))).toBe(1);
    expect(store.countAttachments()).toBe(0);
    store.close();
  });

  it("creates a consistent online backup that can be opened independently", async () => {
    const path = tempPath();
    const destination = join(path, "..", "backup.db");
    const store = new MessageStore(path, 336);
    store.save(message(), [attachment]);
    await store.backup(destination);
    const backup = new MessageStore(destination, 336);
    expect(backup.getEvidence("m1")?.attachments[0].bytes.toString("utf8")).toBe("hello");
    backup.close();
    store.close();
    expect(readFileSync(destination).length).toBeGreaterThan(0);
  });

  it("checkpoints and closes idempotently", () => {
    const store = new MessageStore(tempPath(), 336);
    store.save(message());
    expect(store.close()).toBe(true);
    expect(store.close()).toBe(false);
  });
});
