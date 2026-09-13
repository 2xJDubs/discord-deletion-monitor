import { describe, expect, it, vi } from "vitest";
import { createGuildDeleteHandler, createMessageEventPolicy, type MonitorMessage } from "./message-policy.js";

type Coordinator = { capture(snapshot: unknown): Promise<boolean>; afterCapture(messageId: string, action: () => Promise<void> | void): Promise<void> };

function message(overrides: Partial<MonitorMessage> = {}): MonitorMessage {
  return {
    id: "m1", guildId: "g1", channelId: "c1", content: "plain final text",
    createdAt: new Date("2026-01-01T00:00:00Z"), author: { id: "u1", tag: "user", bot: false },
    webhookId: null, administrator: false, roleIds: [], attachments: [], partial: false,
    ...overrides,
  };
}

function setup() {
  const store = {
    hasConfig: vi.fn(() => true),
    getConfig: vi.fn((): { mode: "all" | "matching"; monitor_administrators: boolean; monitor_attachments: boolean } => ({ mode: "matching", monitor_administrators: false, monitor_attachments: false })),
    listRules: vi.fn((_guildId: string, kind: string) => kind === "keyword" ? ["urgent"] : []),
    get: vi.fn(() => undefined as { matched_reasons: string } | undefined),
    markDeleted: vi.fn(() => true),
  };
  const coordinator: Coordinator = { capture: vi.fn(async () => true), afterCapture: vi.fn(async (_id: string, action: () => Promise<void> | void) => { await action(); }) };
  const deliver = vi.fn(async () => true);
  return { store, coordinator, deliver, policy: createMessageEventPolicy({ store, coordinator, deliver }) };
}

describe("message event policy", () => {
  it("captures nothing for an unconfigured guild even when defaults are all-message mode", async () => {
    const ctx = setup();
    ctx.store.hasConfig.mockReturnValue(false);
    ctx.store.getConfig.mockReturnValue({ mode: "all", monitor_administrators: false, monitor_attachments: false });

    await expect(ctx.policy.create(message())).resolves.toBe(false);

    expect(ctx.coordinator.capture).not.toHaveBeenCalled();
    expect(ctx.store.getConfig).not.toHaveBeenCalled();
  });

  it("keeps an ever-matching message monitored while capturing its latest benign edit", async () => {
    const ctx = setup();
    ctx.store.get.mockReturnValue({ matched_reasons: JSON.stringify(["keyword: urgent"]) });

    await ctx.policy.update(message());

    expect(ctx.coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "m1", content: "plain final text", reasons: ["keyword: urgent"],
    }));
  });

  it("captures the display name and avatar used when the message was seen", async () => {
    const ctx = setup();
    ctx.store.getConfig.mockReturnValue({ mode: "all", monitor_administrators: false, monitor_attachments: false });

    await ctx.policy.create(message({ author: {
      id: "123456789012345678", tag: "account-tag", displayName: "Server Display", avatarUrl: "https://cdn.discordapp.com/avatar.png", bot: false,
    } }));

    expect(ctx.coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({
      authorTag: "Server Display", authorAvatarUrl: "https://cdn.discordapp.com/avatar.png",
    }));
  });

  it("fetches a partial update and captures a newly matching edit", async () => {
    const ctx = setup();
    const fetched = message({ content: "this is urgent", partial: false });
    await ctx.policy.update(message({ partial: true, fetch: vi.fn(async () => fetched) }));
    expect(ctx.coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({ content: "this is urgent", reasons: ["keyword: urgent"] }));
  });

  it("delivers bulk deletes sequentially through after-capture and mark-delete", async () => {
    const ctx = setup();
    let active = 0; let peak = 0;
    ctx.deliver.mockImplementation(async () => { active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return true; });
    await ctx.policy.bulkDelete([message({ id: "m1" }), message({ id: "m2" })]);
    expect(ctx.coordinator.afterCapture).toHaveBeenCalledTimes(2);
    expect(ctx.store.markDeleted).toHaveBeenNthCalledWith(1, "m1");
    expect(ctx.store.markDeleted).toHaveBeenNthCalledWith(2, "m2");
    expect(peak).toBe(1);
  });

  it("purges guild data only for permanent guild removal", async () => {
    const deleteGuildData = vi.fn();
    const handle = createGuildDeleteHandler({ deleteGuildData });
    await handle({ id: "g1", unavailable: true });
    await handle({ id: "g2", unavailable: false });
    expect(deleteGuildData).toHaveBeenCalledTimes(1);
    expect(deleteGuildData).toHaveBeenCalledWith("g2");
  });
});
