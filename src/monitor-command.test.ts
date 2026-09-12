import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_METADATA,
  buildMonitorCommand,
  executeDeferredEphemeral,
  executeMonitorCommand,
  formatDiagnostics,
  formatHelp,
  formatSettings,
  monitoredChannelPermissionError,
} from "./monitor-command.js";

describe("monitor command help", () => {
  it("covers every registered command path without exceeding Discord limits", () => {
    const json = buildMonitorCommand().toJSON();
    const registered = (json.options ?? []).flatMap((option) =>
      option.type === 2
        ? (option.options ?? []).map((sub) => `${option.name} ${sub.name}`)
        : [option.name]);
    expect(new Set(COMMAND_METADATA.map((item) => item.path))).toEqual(new Set(registered));
    expect(json.options?.length).toBeLessThanOrEqual(25);
    expect(COMMAND_METADATA.map((item) => item.topic).filter((value, index, all) => all.indexOf(value) === index).length).toBeLessThanOrEqual(25);
    for (const item of COMMAND_METADATA) expect(formatHelp()).toContain(`/monitor ${item.path}`);
    expect(formatHelp().length).toBeLessThanOrEqual(2000);
    for (const topic of new Set(COMMAND_METADATA.map((item) => item.topic))) {
      const detail = formatHelp(topic);
      expect(detail.length).toBeLessThanOrEqual(2000);
      expect(detail).toContain("Permissions:");
      expect(detail).toContain("Arguments:");
      expect(detail).toContain("Example:");
      expect(detail).toContain("Effects:");
    }
  });

  it("returns safe overview help for an unknown topic", () => {
    expect(formatHelp("not-real")).toContain("Available commands");
    expect(formatHelp("not-real").length).toBeLessThanOrEqual(2000);
  });

  it("registers guided setup, diagnostics, and minute-based retention metadata", () => {
    const paths = new Set(COMMAND_METADATA.map((item) => item.path));
    expect(paths).toContain("setup");
    expect(paths).toContain("diagnostics");
    expect(COMMAND_METADATA.find((item) => item.path === "retention")?.arguments).toContain("minutes");
    const retention = buildMonitorCommand().toJSON().options?.find((option) => option.name === "retention");
    const retentionOption = retention && "options" in retention ? retention.options?.[0] : undefined;
    expect(retentionOption).toMatchObject({ name: "minutes", min_value: 1, max_value: 129600 });
  });
});

describe("monitor command execution", () => {
  it("acknowledges ephemerally before awaiting Discord REST diagnostics and edits the deferred reply", async () => {
    const events: string[] = [];
    let finishFetch!: () => void;
    const interaction = {
      deferReply: vi.fn(async (options: { ephemeral: boolean }) => { events.push(`defer:${options.ephemeral}`); }),
      editReply: vi.fn(async ({ content }: { content: string }) => { events.push(`edit:${content}`); }),
    };
    const pending = executeDeferredEphemeral(interaction, async () => {
      events.push("fetch");
      await new Promise<void>((resolve) => { finishFetch = resolve; });
      return "diagnostics complete";
    });

    await vi.waitFor(() => expect(events).toEqual(["defer:true", "fetch"]));
    expect(interaction.editReply).not.toHaveBeenCalled();
    finishFetch();
    await pending;
    expect(events).toEqual(["defer:true", "fetch", "edit:diagnostics complete"]);
  });

  it("formats status from aggregates without exposing stored content", async () => {
    const store = { getGuildStatus: () => ({ storedMessages: 3, pendingMessages: 1, oldestPendingAt: "2026-01-01T00:00:00Z", attachments: 2, attachmentBytes: 42, attachmentQuotaBytes: 100 }) };
    const result = await executeMonitorCommand({ guildId: "g1", path: "status", values: {} }, store as never);
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain("Stored messages: **3**");
    expect(result.content).toContain("Attachment bytes: **42 / 100**");
    expect(result.content).not.toContain("message content");
    expect(result.content.length).toBeLessThanOrEqual(2000);
  });

  it("validates all effective bot review-channel permissions before saving", async () => {
    const store = { setReviewChannel: vi.fn() };
    const denied = await executeMonitorCommand({
      guildId: "g1", path: "review-channel", values: { channelId: "c1" },
      reviewChannelPermissions: { viewChannel: true, sendMessages: false, embedLinks: false, attachFiles: false },
    }, store as never);
    expect(store.setReviewChannel).not.toHaveBeenCalled();
    expect(denied.content).toContain("Send Messages");
    expect(denied.content).toContain("Embed Links");
    expect(denied.content).toContain("Attach Files");

    await executeMonitorCommand({
      guildId: "g1", path: "review-channel", values: { channelId: "c1" },
      reviewChannelPermissions: { viewChannel: true, sendMessages: true, embedLinks: true, attachFiles: true },
    }, store as never);
    expect(store.setReviewChannel).toHaveBeenCalledWith("g1", "c1");
  });

  it("configures administrator and attachment-only monitoring explicitly", async () => {
    const store = { setMonitorAdministrators: vi.fn(), setMonitorAttachments: vi.fn() };
    await executeMonitorCommand({ guildId: "g1", path: "administrators", values: { value: "monitor" } }, store as never);
    await executeMonitorCommand({ guildId: "g1", path: "attachments", values: { value: "ignore" } }, store as never);
    expect(store.setMonitorAdministrators).toHaveBeenCalledWith("g1", true);
    expect(store.setMonitorAttachments).toHaveBeenCalledWith("g1", false);
  });

  it("bounds settings with counts and previews", () => {
    const many = Array.from({ length: 500 }, (_, index) => `rule-${index}-${"x".repeat(30)}`);
    const output = formatSettings({ mode: "matching", retention_minutes: 90, review_channel_id: null, monitor_administrators: false, monitor_attachments: false }, {
      keyword: many, domain: many, pattern: [], include_channel: many, exclude_channel: many, exclude_role: many,
    });
    expect(output.length).toBeLessThanOrEqual(2000);
    expect(output).toContain("Keywords (500)");
    expect(output).toContain("+495 more");
    expect(output).toContain("Retention: **90 minutes**");
  });

  it("blocks inaccessible monitored channels and reports bounded diagnostics", () => {
    expect(monitoredChannelPermissionError("hidden", false)).toContain("<#hidden>");
    expect(monitoredChannelPermissionError("visible", true)).toBeNull();
    const output = formatDiagnostics({
      reviewChannelId: "review",
      reviewPermissions: { viewChannel: true, sendMessages: false, embedLinks: true, attachFiles: true },
      includedChannelIds: ["visible", "hidden"],
      inaccessibleChannelIds: ["hidden"],
    });
    expect(output).toContain("<#hidden>");
    expect(output).toContain("Send Messages");
    expect(output).toContain("Action required");
    expect(output.length).toBeLessThanOrEqual(2000);
  });

  it("reports an unconfigured guild as inactive rather than all-channel monitoring", () => {
    const output = formatDiagnostics({
      monitoringConfigured: false,
      reviewChannelId: null,
      includedChannelIds: [],
      inaccessibleChannelIds: [],
    });
    expect(output).toContain("Monitoring is not configured");
    expect(output).not.toContain("all channels visible");
  });

  it("requires exact DELETE confirmation before atomically forgetting guild data", async () => {
    const store = { deleteGuildData: vi.fn(() => ({ messages: 2, attachments: 1, rules: 1, config: 1 })) };
    const refused = await executeMonitorCommand({ guildId: "g1", path: "forget", values: { confirm: "delete" } }, store as never);
    expect(store.deleteGuildData).not.toHaveBeenCalled();
    expect(refused.content).toContain("Nothing was deleted");

    const deleted = await executeMonitorCommand({ guildId: "g1", path: "forget", values: { confirm: "DELETE" } }, store as never);
    expect(store.deleteGuildData).toHaveBeenCalledWith("g1");
    expect(deleted.content).toContain("2 message(s)");
    expect(deleted.content).toContain("1 configuration record(s)");
  });
});
