import { describe, expect, it, vi } from "vitest";
import { toMonitorMessage } from "./discord-message.js";

describe("toMonitorMessage", () => {
  it("falls back to user-level display data when guild-member data is absent", () => {
    const displayAvatarURL = vi.fn(() => "https://cdn.test/user.png");
    const message = {
      id: "m1", guildId: "g1", channelId: "c1", content: "hello", createdAt: new Date("2026-01-01T00:00:00Z"),
      author: { id: "u1", tag: "account-tag", displayName: "Global Name", bot: false, displayAvatarURL },
      member: null, webhookId: null, attachments: [], partial: false,
    };

    expect(toMonitorMessage(message)).toMatchObject({
      author: { displayName: "Global Name", avatarUrl: "https://cdn.test/user.png" },
      administrator: false,
      roleIds: [],
    });
    expect(displayAvatarURL).toHaveBeenCalledWith({ extension: "png", size: 64 });
  });

  it("converts the full Discord message returned by a partial-message fetch", async () => {
    const full = {
      id: "m1", guildId: "g1", channelId: "c1", content: "fetched", createdAt: new Date("2026-01-01T00:00:00Z"),
      author: { id: "u1", tag: "account-tag", displayName: "Global Name", bot: false, displayAvatarURL: () => "https://cdn.test/user.png" },
      member: null, webhookId: null, attachments: [], partial: false,
    };
    const partial = { ...full, content: "", author: null, partial: true, fetch: vi.fn(async () => full) };

    const converted = toMonitorMessage(partial);

    await expect(converted.fetch?.()).resolves.toMatchObject({
      id: "m1", content: "fetched", partial: false,
      author: { displayName: "Global Name", avatarUrl: "https://cdn.test/user.png" },
    });
    expect(partial.fetch).toHaveBeenCalledOnce();
  });

  it("snapshots the guild display name and avatar at gateway capture time", () => {
    const message = {
      id: "m1", guildId: "g1", channelId: "c1", content: "hello", createdAt: new Date("2026-01-01T00:00:00Z"),
      author: { id: "123456789012345678", tag: "account-tag", displayName: "Global Name", bot: false, displayAvatarURL: vi.fn(() => "https://cdn.test/user.png") },
      member: { displayName: "Guild Nick", displayAvatarURL: vi.fn(() => "https://cdn.test/member.png"), permissions: { has: () => false }, roles: { cache: new Map() } },
      webhookId: null, attachments: [], partial: false,
    };

    expect(toMonitorMessage(message)).toMatchObject({
      author: { id: "123456789012345678", tag: "account-tag", displayName: "Guild Nick", avatarUrl: "https://cdn.test/member.png", bot: false },
    });
    expect(message.member.displayAvatarURL).toHaveBeenCalledWith({ extension: "png", size: 64 });
  });
});
