import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MessageStore, type StoredEvidence } from "./database.js";
import { buildEvidencePayload, buildEvidencePayloads, deliverEvidence } from "./evidence.js";

function evidence(content = "hello"): StoredEvidence {
  return {
    message: {
      message_id: "m1", guild_id: "g1", channel_id: "c1", author_id: "u1",
      author_tag: "@everyone attacker", content, attachment_urls: "[]",
      matched_reasons: JSON.stringify(["keyword: urgent"]), created_at: "2026-01-01T00:00:00.000Z",
    },
    attachments: [{
      attachment_id: "a1", message_id: "m1", filename: "proof.txt", content_type: "text/plain",
      size: 5, source_url: "https://cdn.test/a1", bytes: Buffer.from("proof"),
    }],
  };
}

describe("buildEvidencePayload", () => {
  it("splits evidence into at most ten files per Discord payload", () => {
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 21 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: `https://cdn.test/${index}`, bytes: Buffer.from("x"),
    }));
    const payloads = buildEvidencePayloads(item);
    expect(payloads.length).toBe(3);
    expect(payloads.every((payload) => payload.files.length <= 10)).toBe(true);
    expect(payloads[0].files[0].name).toBe("deleted-message-m1.txt");
  });
  it("formats short evidence under 2,000 characters with mentions disabled and preserved files", () => {
    const payload = buildEvidencePayload(evidence());
    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(payload.content).toContain("hello");
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload.files).toEqual([expect.objectContaining({ name: "proof.txt", attachment: Buffer.from("proof") })]);
  });

  it("escapes attacker-controlled Markdown while preserving trusted labels", () => {
    const item = evidence("# heading **bold** [link](https://evil.test) ||spoiler|| <@123> @everyone");
    item.message.author_tag = "**admin** `code` @here";
    item.message.matched_reasons = JSON.stringify(["keyword: **urgent**", "pattern: ||hide||"]);
    const payload = buildEvidencePayload(item);
    expect(payload.content).toContain("**Deleted message captured**");
    expect(payload.content).toContain("Content:\n\\# heading \\*\\*bold\\*\\* \\[link\\]\\(https://evil\\.test\\) \\|\\|spoiler\\|\\|");
    expect(payload.content).toContain("Author: \\*\\*admin\\*\\* \\`code\\`");
    expect(payload.content).toContain("Matched: keyword: \\*\\*urgent\\*\\*, pattern: \\|\\|hide\\|\\|");
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload.content).not.toContain("<@123>");
    expect(payload.content).not.toContain("@everyone");
    expect(payload.content).not.toContain("@here");
  });

  it("removes every Unicode directional control from preserved filenames", () => {
    const item = evidence();
    const controls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    item.attachments[0].filename = `report${controls}cod.exe`;
    expect(buildEvidencePayload(item).files[0].name).toBe("reportcod.exe");
  });

  it("attaches full long UTF-8 content and keeps the message concise", () => {
    const content = "🔥 <@123> ".repeat(700);
    const payload = buildEvidencePayload(evidence(content));
    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(payload.content).toContain("attached as deleted-message-m1.txt");
    const contentFile = payload.files.find((file) => file.name === "deleted-message-m1.txt");
    expect(contentFile?.attachment.toString("utf8")).toBe(content);
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });
});

describe("deliverEvidence", () => {
  function setup(reviewChannelId: string | null = "review") {
    const item = evidence();
    const store = {
      getEvidence: vi.fn(() => item),
      getConfig: vi.fn(() => ({ review_channel_id: reviewChannelId })),
      removeClaimed: vi.fn(() => true),
      renewDeliveryClaim: vi.fn<(messageId: string, token: string, now: Date, leaseMs: number) => boolean>(() => true),
      isClaimDeliverable: vi.fn(() => true),
      advanceDeliveryBatch: vi.fn(() => true),
      scheduleRetry: vi.fn(),
    };
    const send = vi.fn<(payload: unknown) => Promise<unknown>>(async () => undefined);
    const fetchChannel = vi.fn<() => Promise<{ isSendable: () => boolean; send: typeof send } | null>>(async () => ({ isSendable: () => true, send }));
    const log = vi.fn();
    return { store, send, fetchChannel, log };
  }

  it("removes evidence only after Discord delivery succeeds", async () => {
    const ctx = setup();
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [], repliedUser: false } }));
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-a");
    expect(ctx.send.mock.invocationCallOrder[0]).toBeLessThan(ctx.store.removeClaimed.mock.invocationCallOrder[0]);
  });

  it("retains evidence when no review channel is configured", async () => {
    const ctx = setup(null);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.fetchChannel).not.toHaveBeenCalled();
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
  });

  it("retains evidence when the review channel is unavailable or not sendable", async () => {
    const ctx = setup();
    ctx.fetchChannel.mockResolvedValueOnce(null);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
  });

  it("retains evidence and logs when channel fetch or send fails", async () => {
    const ctx = setup();
    ctx.send.mockRejectedValueOnce(new Error("missing permissions"));
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("evidence_delivery_failed", expect.objectContaining({ error: "missing permissions" }));
    expect(ctx.store.scheduleRetry).toHaveBeenCalledWith("m1", expect.any(Error), expect.any(Date), { claimToken: "claim-a" });
  });

  it("keeps a blocked multi-batch send leased so a replacement cannot claim it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const directory = mkdtempSync(join(tmpdir(), "evidence-lease-"));
    const path = join(directory, "messages.db");
    const first = new MessageStore(path, 336);
    const second = new MessageStore(path, 336);
    try {
      const item = evidence("x".repeat(3000));
      item.attachments = Array.from({ length: 11 }, (_, index) => ({
        attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
        size: 1, source_url: "url", bytes: Buffer.from("x"),
      }));
      first.save(item.message, item.attachments);
      first.markDeleted("m1", new Date());
      first.setReviewChannel("g1", "review");
      expect(first.claimDelivery("m1", "claim-a", new Date(), 100)).toBe(true);

      let releaseFirstSend!: () => void;
      const send = vi.fn<(payload: unknown) => Promise<unknown>>()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstSend = resolve; }))
        .mockResolvedValue(undefined);
      const fetchChannel = async () => ({ isSendable: () => true, send });
      const delivery = deliverEvidence("g1", "m1", "claim-a", first, fetchChannel, undefined, {
        leaseMs: 100,
        heartbeatMs: 25,
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(second.claimDelivery("m1", "claim-b", new Date(), 100)).toBe(false);

      releaseFirstSend();
      await expect(delivery).resolves.toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("rejects a stale token before a later batch after ownership changes", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    ctx.store.renewDeliveryClaim.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await expect(deliverEvidence("g1", "m1", "stale-token", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "stale-token", 1);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.scheduleRetry).toHaveBeenCalledWith("m1", expect.any(Error), expect.any(Date), { claimToken: "stale-token" });
  });

  it("removes only after every payload batch succeeds and retries partial failure", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    ctx.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("batch two failed"));
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.send).toHaveBeenCalledTimes(2);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "claim-a", 1);
    expect(ctx.store.scheduleRetry).toHaveBeenCalled();
  });

  it("resumes after the last durably completed payload batch", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.message.delivery_batch_index = 1;
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    await expect(deliverEvidence("g1", "m1", "claim-b", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "claim-b", 2);
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-b");
  });

  it("aborts before any irreversible send once retention/ownership is lost", async () => {
    const ctx = setup();
    ctx.store.isClaimDeliverable.mockReturnValue(false);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.scheduleRetry).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("evidence_delivery_fenced", expect.objectContaining({ guildId: "g1", messageId: "m1" }));
  });

  it("aborts mid-batch and does not log success once a fence check fails before send", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    ctx.store.isClaimDeliverable.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.scheduleRetry).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("evidence_delivery_fenced", expect.objectContaining({ guildId: "g1", messageId: "m1" }));
  });
});
