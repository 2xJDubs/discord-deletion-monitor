import "dotenv/config";
import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { MessageStore, MonitorMode, RuleKind } from "./database.js";
import { BUILT_IN_PATTERNS, detectReasons, normalizeDomain } from "./detector.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required");

const defaultRetentionHours = Math.max(1, Math.round(Number(process.env.RETENTION_HOURS ?? "336")));
const store = new MessageStore(process.env.DATABASE_PATH ?? "./data/messages.db", defaultRetentionHours);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const command = new SlashCommandBuilder()
  .setName("monitor")
  .setDescription("Configure deleted-message monitoring")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub.setName("review-channel").setDescription("Set the private evidence channel")
    .addChannelOption((option) => option.setName("channel").setDescription("Moderator review channel")
      .addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand((sub) => sub.setName("retention").setDescription("Set how long matching messages remain cached")
    .addIntegerOption((option) => option.setName("hours").setDescription("Hours to retain messages (1–2160)")
      .setMinValue(1).setMaxValue(2160).setRequired(true)))
  .addSubcommand((sub) => sub.setName("mode").setDescription("Choose whether to cache all messages or matches only")
    .addStringOption((option) => option.setName("value").setDescription("Monitoring mode").setRequired(true)
      .addChoices({ name: "Matching messages only", value: "matching" }, { name: "All messages", value: "all" })))
  .addSubcommandGroup((group) => group.setName("keyword").setDescription("Manage watched phrases")
    .addSubcommand((sub) => sub.setName("add").setDescription("Add a watched phrase")
      .addStringOption((option) => option.setName("value").setDescription("Phrase").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove").setDescription("Remove a watched phrase")
      .addStringOption((option) => option.setName("value").setDescription("Phrase").setRequired(true))))
  .addSubcommandGroup((group) => group.setName("domain").setDescription("Manage watched domains")
    .addSubcommand((sub) => sub.setName("add").setDescription("Add a watched domain")
      .addStringOption((option) => option.setName("value").setDescription("Domain, such as example.com").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove").setDescription("Remove a watched domain")
      .addStringOption((option) => option.setName("value").setDescription("Domain").setRequired(true))))
  .addSubcommandGroup((group) => group.setName("pattern").setDescription("Manage built-in scam patterns")
    .addSubcommand((sub) => sub.setName("add").setDescription("Enable a pattern")
      .addStringOption((option) => option.setName("value").setDescription("Pattern").setRequired(true)
        .addChoices(...Object.keys(BUILT_IN_PATTERNS).map((name) => ({ name, value: name })))))
    .addSubcommand((sub) => sub.setName("remove").setDescription("Disable a pattern")
      .addStringOption((option) => option.setName("value").setDescription("Pattern").setRequired(true)
        .addChoices(...Object.keys(BUILT_IN_PATTERNS).map((name) => ({ name, value: name }))))))
  .addSubcommandGroup((group) => group.setName("channel").setDescription("Manage monitored channel scope")
    .addSubcommand((sub) => sub.setName("include").setDescription("Add a channel to the include list")
      .addChannelOption((option) => option.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((sub) => sub.setName("exclude").setDescription("Exclude a channel")
      .addChannelOption((option) => option.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove-include").setDescription("Remove a channel from the include list")
      .addChannelOption((option) => option.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove-exclude").setDescription("Remove a channel exclusion")
      .addChannelOption((option) => option.setName("channel").setDescription("Channel").setRequired(true))))
  .addSubcommandGroup((group) => group.setName("role").setDescription("Manage trusted roles whose posts are ignored")
    .addSubcommand((sub) => sub.setName("exclude").setDescription("Ignore messages from members with this role")
      .addRoleOption((option) => option.setName("role").setDescription("Trusted/admin role").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove-exclusion").setDescription("Stop ignoring this role")
      .addRoleOption((option) => option.setName("role").setDescription("Role").setRequired(true))))
  .addSubcommand((sub) => sub.setName("settings").setDescription("Show this server's monitoring settings"))
  .addSubcommand((sub) => sub.setName("test").setDescription("Test text against the current detection rules")
    .addStringOption((option) => option.setName("message").setDescription("Sample message").setRequired(true)));

function formatList(values: string[], format = (value: string) => value): string {
  return values.length ? values.map(format).join(", ") : "none";
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (!group && subcommand === "review-channel") {
    const channel = interaction.options.getChannel("channel", true);
    store.setReviewChannel(guildId, channel.id);
    await interaction.reply({ content: `Review channel set to <#${channel.id}>.`, ephemeral: true });
    return;
  }
  if (!group && subcommand === "retention") {
    const hours = interaction.options.getInteger("hours", true);
    store.setRetention(guildId, hours);
    await interaction.reply({ content: `Matching messages will be retained for ${hours} hour(s).`, ephemeral: true });
    return;
  }
  if (!group && subcommand === "mode") {
    const mode = interaction.options.getString("value", true) as MonitorMode;
    store.setMode(guildId, mode);
    await interaction.reply({ content: `Monitoring mode set to **${mode}**.`, ephemeral: true });
    return;
  }
  if (!group && subcommand === "test") {
    const message = interaction.options.getString("message", true);
    const reasons = detectReasons(message, store.listRules(guildId, "keyword"), store.listRules(guildId, "domain"), store.listRules(guildId, "pattern"));
    await interaction.reply({ content: reasons.length ? `Would be saved: ${reasons.join(", ")}` : "Would not be saved in matching mode.", ephemeral: true });
    return;
  }
  if (!group && subcommand === "settings") {
    const config = store.getConfig(guildId);
    const line = (kind: RuleKind, format?: (value: string) => string) => formatList(store.listRules(guildId, kind), format);
    await interaction.reply({ ephemeral: true, content: [
      `Mode: **${config.mode}**`,
      `Retention: **${config.retention_hours} hours**`,
      `Review channel: ${config.review_channel_id ? `<#${config.review_channel_id}>` : "not configured"}`,
      "Any link: **watched automatically**",
      "Administrators: **ignored automatically**",
      `Keywords: ${line("keyword")}`,
      `Domains: ${line("domain")}`,
      `Patterns: ${line("pattern")}`,
      `Included channels: ${line("include_channel", (id) => `<#${id}>`)}`,
      `Excluded channels: ${line("exclude_channel", (id) => `<#${id}>`)}`,
      `Excluded roles: ${line("exclude_role", (id) => `<@&${id}>`)}`,
    ].join("\n") });
    return;
  }

  let kind: RuleKind;
  let value: string;
  let remove = subcommand.startsWith("remove");
  if (group === "keyword") {
    kind = "keyword";
    value = interaction.options.getString("value", true).trim().toLowerCase();
    remove = subcommand === "remove";
  } else if (group === "domain") {
    kind = "domain";
    value = normalizeDomain(interaction.options.getString("value", true));
    remove = subcommand === "remove";
  } else if (group === "pattern") {
    kind = "pattern";
    value = interaction.options.getString("value", true);
    remove = subcommand === "remove";
  } else if (group === "channel") {
    kind = subcommand.includes("include") ? "include_channel" : "exclude_channel";
    value = interaction.options.getChannel("channel", true).id;
  } else if (group === "role") {
    kind = "exclude_role";
    value = interaction.options.getRole("role", true).id;
  } else {
    await interaction.reply({ content: "Unknown setting.", ephemeral: true });
    return;
  }
  if (!value) {
    await interaction.reply({ content: "The value cannot be empty.", ephemeral: true });
    return;
  }
  const changed = remove ? store.removeRule(guildId, kind, value) : store.addRule(guildId, kind, value);
  await interaction.reply({ content: changed ? `Setting ${remove ? "removed" : "added"}.` : `That setting was already ${remove ? "absent" : "configured"}.`, ephemeral: true });
}

client.once(Events.ClientReady, async (readyClient) => {
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationCommands(readyClient.user.id), { body: [command.toJSON()] });
  console.log(`Ready as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} server(s)`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "monitor") return;
  await handleCommand(interaction).catch(async (error: unknown) => {
    console.error(error);
    const response = { content: "The setting could not be updated. Check the bot logs.", ephemeral: true } as const;
    if (interaction.replied || interaction.deferred) await interaction.followUp(response);
    else await interaction.reply(response);
  });
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guildId || !message.member || message.author.bot || message.webhookId) return;
  const guildId = message.guildId;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
  if (store.listRules(guildId, "exclude_role").some((roleId) => message.member!.roles.cache.has(roleId))) return;
  const included = store.listRules(guildId, "include_channel");
  if (included.length && !included.includes(message.channelId)) return;
  if (store.listRules(guildId, "exclude_channel").includes(message.channelId)) return;

  const config = store.getConfig(guildId);
  const reasons = detectReasons(message.content, store.listRules(guildId, "keyword"), store.listRules(guildId, "domain"), store.listRules(guildId, "pattern"));
  if (config.mode === "matching" && !reasons.length) return;
  store.save({
    message_id: message.id,
    guild_id: guildId,
    channel_id: message.channelId,
    author_id: message.author.id,
    author_tag: message.author.tag,
    content: message.content,
    attachment_urls: JSON.stringify(message.attachments.map((attachment) => attachment.url)),
    matched_reasons: JSON.stringify(reasons),
    created_at: message.createdAt.toISOString(),
  });
});

client.on(Events.MessageDelete, async (message) => {
  if (!message.guildId) return;
  const saved = store.get(message.id);
  if (!saved) return;
  const reviewChannelId = store.getConfig(message.guildId).review_channel_id;
  if (reviewChannelId) {
    const channel = await client.channels.fetch(reviewChannelId).catch(() => null);
    if (channel?.isSendable()) {
      const attachments = JSON.parse(saved.attachment_urls) as string[];
      const reasons = JSON.parse(saved.matched_reasons) as string[];
      await channel.send({ allowedMentions: { parse: [] }, content: [
        "**Deleted message captured**",
        `Author: ${saved.author_tag} (\`${saved.author_id}\`)`,
        `Channel: <#${saved.channel_id}>`,
        `Posted: <t:${Math.floor(new Date(saved.created_at).getTime() / 1000)}:F>`,
        reasons.length ? `Matched: ${reasons.join(", ")}` : "Matched: all-message mode",
        `Content:\n${saved.content || "*(no text content)*"}`,
        attachments.length ? `Attachments: ${attachments.join(" ")}` : "",
      ].filter(Boolean).join("\n") });
    }
  }
  store.remove(message.id);
});

setInterval(() => {
  const removed = store.purgeExpired(new Date());
  if (removed) console.log(`Purged ${removed} expired message snapshot(s)`);
}, 15 * 60 * 1000).unref();

await client.login(token);
