import { describe, expect, it, vi } from "vitest";
import { captureMessage } from "./capture.js";

const snapshot = {
  messageId: "m1", guildId: "g1", channelId: "c1", authorId: "u1", authorTag: "user",
  content: "hello", createdAt: new Date("2026-01-01T00:00:00Z"), reasons: ["link (1)"],
  attachments: [{ id: "a1", url: "https://cdn.test/a", name: "a.txt", contentType: "text/plain", size: 3 }],
};

describe("captureMessage", () => {
  it("downloads attachments before atomically saving the message evidence", async () => {
    const bytes = [{ attachment_id: "a1", message_id: "m1", filename: "a.txt", content_type: "text/plain", size: 3, source_url: "https://cdn.test/a", bytes: Buffer.from("abc") }];
    const download = vi.fn(async () => bytes);
    const save = vi.fn();
    await captureMessage(snapshot, { save }, download);
    expect(download).toHaveBeenCalledWith("m1", snapshot.attachments);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ message_id: "m1", attachment_urls: JSON.stringify(["https://cdn.test/a"]) }), bytes);
  });

  it("still saves message text when attachment downloading returns no files", async () => {
    const save = vi.fn();
    await expect(captureMessage(snapshot, { save }, async () => [])).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ content: "hello" }), []);
  });
});
