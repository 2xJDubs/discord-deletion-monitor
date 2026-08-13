import "dotenv/config";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { MessageStore } from "./database.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required");

const retentionDays = Number(process.env.RETENTION_DAYS ?? "14");
const store = new MessageStore(process.env.DATABASE_PATH ?? "./data/messages.db");
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const configureCommand = new SlashCommandBuilder()
  .setName("deletion-monitor")
  .setDescription("Configure deleted-message review for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((option) =>
    option.setName("review-channel")
      .setDescription("Private channel that receives deleted-message evidence")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  );

client.once(Events.ClientReady, async (readyClient) => {
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationCommands(readyClient.user.id), { body: [configureCommand.toJSON()] });
  console.log(`Ready as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} server(s)`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "deletion-monitor" || !interaction.guildId) return;
  const channel = interaction.options.getChannel("review-channel", true);
  store.setReviewChannel(interaction.guildId, channel.id);
  await interaction.reply({ content: `Deleted messages will be reported in <#${channel.id}>.`, ephemeral: true });
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guildId || message.author.bot || message.webhookId) return;
  store.save({
    message_id: message.id,
    guild_id: message.guildId,
    channel_id: message.channelId,
    author_id: message.author.id,
    author_tag: message.author.tag,
    content: message.content,
    attachment_urls: JSON.stringify(message.attachments.map((attachment) => attachment.url)),
    created_at: message.createdAt.toISOString(),
  });
});

client.on(Events.MessageDelete, async (message) => {
  if (!message.guildId) return;
  const saved = store.get(message.id);
  if (!saved) return;

  const reviewChannelId = store.getReviewChannel(message.guildId);
  if (reviewChannelId) {
    const channel = await client.channels.fetch(reviewChannelId).catch(() => null);
    if (channel?.isSendable()) {
      const attachments = JSON.parse(saved.attachment_urls) as string[];
      await channel.send({
        allowedMentions: { parse: [] },
        content: [
          "**Deleted message captured**",
          `Author: ${saved.author_tag} (\`${saved.author_id}\`)`,
          `Channel: <#${saved.channel_id}>`,
          `Posted: <t:${Math.floor(new Date(saved.created_at).getTime() / 1000)}:F>`,
          `Content:\n${saved.content || "*(no text content)*"}`,
          attachments.length ? `Attachments: ${attachments.join(" ")}` : "",
        ].filter(Boolean).join("\n"),
      });
    }
  }
  store.remove(message.id);
});

setInterval(() => {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const removed = store.purgeOlderThan(cutoff);
  if (removed) console.log(`Purged ${removed} expired message snapshot(s)`);
}, 60 * 60 * 1000).unref();

await client.login(token);
