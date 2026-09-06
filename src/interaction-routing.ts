import { executeDeferredEphemeral, monitoredChannelPermissionError } from "./monitor-command.js";

type ReplyPayload = { content: string; ephemeral: true };
type ReplyInteraction = { reply(options: ReplyPayload): Promise<unknown> };
type FailureInteraction = ReplyInteraction & {
  deferred: boolean;
  replied: boolean;
  editReply(options: { content: string }): Promise<unknown>;
  followUp(options: ReplyPayload): Promise<unknown>;
};
type DeferredInteraction<Guild> = {
  guild: Guild | null;
  reply(options: ReplyPayload): Promise<unknown>;
  deferReply(options: { ephemeral: true }): Promise<unknown>;
  editReply(options: { content: string }): Promise<unknown>;
};

export async function respondToInteractionFailure(interaction: FailureInteraction, response: ReplyPayload): Promise<void> {
  if (interaction.deferred) {
    await interaction.editReply({ content: response.content });
  } else if (interaction.replied) {
    await interaction.followUp(response);
  } else {
    await interaction.reply(response);
  }
}

export async function replyForUnavailableGuild(interaction: ReplyInteraction, action: string): Promise<void> {
  await interaction.reply({
    content: `I could not access this server to ${action}. Please try again in the server.`,
    ephemeral: true,
  });
}

export async function executeDirectChannelInclusion<Guild>(
  interaction: DeferredInteraction<Guild>,
  guildId: string,
  channelId: string,
  addRule: (guildId: string, kind: "include_channel", channelId: string) => boolean,
  inaccessibleChannelIds: (guild: Guild, channelIds: string[]) => Promise<string[]>,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "I could not access this server's channel list. Please try again in the server; no monitoring setting was changed.",
      ephemeral: true,
    });
    return;
  }
  await executeDeferredEphemeral(interaction, async () => {
    const inaccessible = await inaccessibleChannelIds(guild, [channelId]);
    const permissionError = monitoredChannelPermissionError(channelId, inaccessible.length === 0);
    if (permissionError) return permissionError;
    const changed = addRule(guildId, "include_channel", channelId);
    return changed ? "Setting added." : "That setting was already configured.";
  });
}
