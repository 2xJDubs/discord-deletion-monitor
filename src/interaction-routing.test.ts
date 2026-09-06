import { describe, expect, it, vi } from "vitest";
import { executeDirectChannelInclusion, replyForUnavailableGuild, respondToInteractionFailure } from "./interaction-routing.js";

describe("interaction routing", () => {
  it("fails closed and acknowledges when direct channel inclusion cannot access the guild", async () => {
    const interaction = {
      guild: null,
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
    const addRule = vi.fn(() => true);
    const checkChannels = vi.fn(async () => [] as string[]);

    await executeDirectChannelInclusion(interaction, "guild", "channel", addRule, checkChannels);

    expect(addRule).not.toHaveBeenCalled();
    expect(checkChannels).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("try again"),
    }));
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("acknowledges diagnostics ephemerally when the guild object is unavailable", async () => {
    const interaction = { reply: vi.fn(async () => undefined) };

    await replyForUnavailableGuild(interaction, "run diagnostics");

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("run diagnostics"),
    }));
  });

  it("acknowledges setup components ephemerally when the guild object is unavailable", async () => {
    const interaction = { reply: vi.fn(async () => undefined) };

    await replyForUnavailableGuild(interaction, "continue setup");

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("continue setup"),
    }));
  });

  it("edits the original reply when a deferred command fails without double acknowledgment", async () => {
    const interaction = {
      deferred: true,
      replied: true,
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    };

    await respondToInteractionFailure(interaction, { content: "failed", ephemeral: true });

    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "failed" });
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("follows up only when an already-replied command fails", async () => {
    const interaction = {
      deferred: false,
      replied: true,
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    };
    const response = { content: "failed", ephemeral: true } as const;

    await respondToInteractionFailure(interaction, response);

    expect(interaction.followUp).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith(response);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
