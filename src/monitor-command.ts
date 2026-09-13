import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type SlashCommandSubcommandBuilder } from "discord.js";
import { BUILT_IN_PATTERNS } from "./detector.js";
import type { RuleKind } from "./database.js";

export type CommandMetadata = {
  path: string;
  category: string;
  topic: string;
  purpose: string;
  permissions: string;
  arguments: string;
  example: string;
  effects: string;
};
const manage = "Manage Server";
export const COMMAND_METADATA: CommandMetadata[] = [
  ["help", "overview", "Show command guidance", manage, "topic (optional)", "/monitor help topic:retention", "Reads configuration only"],
  ["setup", "setup", "Guide monitored-channel selection and permission checks", manage, "interactive channel selection", "/monitor setup", "Replaces the monitored-channel list only after confirmation"],
  ["review-channel", "setup", "Set the private evidence destination", manage, "channel (required)", "/monitor review-channel channel:#reviews", "Validates bot permissions, then saves the channel"],
  ["retention", "setup", "Set evidence retention", manage, "minutes: 1–129600", "/monitor retention minutes:60", "Changes when cached evidence expires"],
  ["mode", "setup", "Cache all eligible messages or matches only", manage, "value: matching|all", "/monitor mode value:all", "Changes future capture eligibility"],
  ["administrators", "privacy", "Monitor or ignore administrator messages", manage, "value: monitor|ignore", "/monitor administrators value:ignore", "Changes future administrator capture"],
  ["attachments", "privacy", "Monitor or ignore attachment-only matches", manage, "value: monitor|ignore", "/monitor attachments value:monitor", "Changes future attachment-only capture"],
  ["keyword add", "detection", "Add a watched phrase", manage, "value (required)", "/monitor keyword add value:urgent", "Adds one detection rule"],
  ["keyword remove", "detection", "Remove a watched phrase", manage, "value (required)", "/monitor keyword remove value:urgent", "Removes one detection rule"],
  ["domain add", "detection", "Add a watched domain", manage, "value (required)", "/monitor domain add value:example.com", "Adds one normalized domain rule"],
  ["domain remove", "detection", "Remove a watched domain", manage, "value (required)", "/monitor domain remove value:example.com", "Removes one domain rule"],
  ["pattern add", "detection", "Enable a built-in pattern", manage, "value (required)", "/monitor pattern add value:payment", "Enables one built-in detector"],
  ["pattern remove", "detection", "Disable a built-in pattern", manage, "value (required)", "/monitor pattern remove value:payment", "Disables one built-in detector"],
  ["channel include", "scope", "Add a monitored-channel allowlist entry", manage, "channel (required)", "/monitor channel include channel:#general", "Narrows monitored channels when any include exists"],
  ["channel exclude", "scope", "Exclude a channel", manage, "channel (required)", "/monitor channel exclude channel:#staff", "Ignores future messages in the channel"],
  ["channel remove-include", "scope", "Remove a channel allowlist entry", manage, "channel (required)", "/monitor channel remove-include channel:#general", "Expands monitored channel scope"],
  ["channel remove-exclude", "scope", "Remove a channel exclusion", manage, "channel (required)", "/monitor channel remove-exclude channel:#staff", "Restores channel eligibility"],
  ["role exclude", "scope", "Ignore messages from a trusted role", manage, "role (required)", "/monitor role exclude role:@trusted", "Ignores future messages from that role"],
  ["role remove-exclusion", "scope", "Remove a trusted-role exclusion", manage, "role (required)", "/monitor role remove-exclusion role:@trusted", "Restores role eligibility"],
  ["settings", "diagnostics", "Show bounded configuration previews", manage, "none", "/monitor settings", "Reads settings only"],
  ["diagnostics", "diagnostics", "Check monitored and review-channel permissions", manage, "none", "/monitor diagnostics", "Reads effective bot permissions only"],
  ["status", "diagnostics", "Show redacted aggregate storage status", manage, "none", "/monitor status", "Reads counts and byte totals; never message content"],
  ["test", "diagnostics", "Test sample text against current rules", manage, "message (required)", "/monitor test message:urgent", "Reads rules; does not store sample text"],
  ["forget", "privacy", "Permanently erase this server's monitor data", manage, "confirm must equal DELETE", "/monitor forget confirm:DELETE", "Atomically deletes configuration, rules, messages, and attachments"],
].map(([path, category, purpose, permissions, arguments_, example, effects]) => ({
  path, category, topic: path.split(" ")[0], purpose, permissions, arguments: arguments_, example, effects,
}));

const topics = [...new Set(COMMAND_METADATA.map((item) => item.topic))];
export function formatHelp(topic?: string | null): string {
  if (!topic || !topics.includes(topic)) {
    const categories = [...new Set(COMMAND_METADATA.map((item) => item.category))].map((name) => `**${name}**\n${COMMAND_METADATA.filter((item) => item.category === name).map((item) => `• \`/monitor ${item.path}\` — ${item.purpose}`).join("\n")}`);
    return `**Monitor help — Available commands**\n${categories.join("\n")}`.slice(0, 2000);
  }
  const entries = COMMAND_METADATA.filter((item) => item.topic === topic).map((item) =>
    `**/monitor ${item.path}** — ${item.purpose}\nPermissions: ${item.permissions}\nArguments: ${item.arguments}\nExample: \`${item.example}\`\nEffects: ${item.effects}`);
  return `**Monitor help: ${topic}**\n${entries.join("\n\n")}`.slice(0, 2000);
}

export type MonitorCommandRequest = {
  guildId: string;
  path: string;
  values: Record<string, string | number | boolean | null | undefined>;
  reviewChannelPermissions?: { viewChannel: boolean; sendMessages: boolean; embedLinks: boolean; attachFiles: boolean };
};
export type MonitorCommandResult = { content: string; ephemeral: true };
export async function executeDeferredEphemeral(
  interaction: { deferReply(options: { ephemeral: true }): Promise<unknown>; editReply(options: { content: string }): Promise<unknown> },
  action: () => Promise<string>,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: await action() });
}

type MonitorCommandStore = {
  getGuildStatus(guildId: string): { storedMessages: number; pendingMessages: number; oldestPendingAt: string | null; attachments: number; attachmentBytes: number; attachmentQuotaBytes: number };
  deleteGuildData(guildId: string): { messages: number; attachments: number; rules: number; config: number };
  setReviewChannel(guildId: string, channelId: string): void;
  setMonitorAdministrators(guildId: string, enabled: boolean): void;
  setMonitorAttachments(guildId: string, enabled: boolean): void;
};

export async function executeMonitorCommand(request: MonitorCommandRequest, store: MonitorCommandStore): Promise<MonitorCommandResult> {
  if (request.path === "help") return { content: formatHelp(String(request.values.topic ?? "")), ephemeral: true };
  if (request.path === "status") {
    const status = store.getGuildStatus(request.guildId);
    return { ephemeral: true, content: [
      "**Monitor status (aggregate only)**",
      `Stored messages: **${status.storedMessages}**`,
      `Pending deliveries: **${status.pendingMessages}**`,
      `Oldest evidence: **${status.oldestPendingAt ?? "none"}**`,
      `Attachments: **${status.attachments}**`,
      `Attachment bytes: **${status.attachmentBytes} / ${status.attachmentQuotaBytes}**`,
    ].join("\n").slice(0, 2000) };
  }
  if (request.path === "forget") {
    if (request.values.confirm !== "DELETE") return { content: "Nothing was deleted. Type DELETE exactly to confirm.", ephemeral: true };
    const counts = store.deleteGuildData(request.guildId);
    return { content: `Monitor data erased: ${counts.messages} message(s), ${counts.attachments} attachment(s), ${counts.rules} rule(s), and ${counts.config} configuration record(s).`, ephemeral: true };
  }
  if (request.path === "review-channel") {
    const permissions = request.reviewChannelPermissions;
    const missing = [
      !permissions?.viewChannel && "View Channel",
      !permissions?.sendMessages && "Send Messages",
      !permissions?.embedLinks && "Embed Links",
      !permissions?.attachFiles && "Attach Files",
    ].filter(Boolean);
    if (missing.length) return { content: `I cannot use that channel. Grant me: ${missing.join(", ")}.`, ephemeral: true };
    const channelId = String(request.values.channelId ?? "");
    store.setReviewChannel(request.guildId, channelId);
    return { content: `Review channel set to <#${channelId}>.`, ephemeral: true };
  }
  if (request.path === "administrators" || request.path === "attachments") {
    const enabled = request.values.value === "monitor";
    if (request.path === "administrators") store.setMonitorAdministrators(request.guildId, enabled);
    else store.setMonitorAttachments(request.guildId, enabled);
    return { content: `${request.path === "administrators" ? "Administrator messages" : "Attachment-only messages"} will be **${enabled ? "monitored" : "ignored"}**.`, ephemeral: true };
  }
  return { content: "Unknown monitor command.", ephemeral: true };
}

export function formatSettings(
  config: { mode: string; retention_minutes: number; review_channel_id: string | null; monitor_administrators?: boolean; monitor_attachments?: boolean },
  rules: Record<RuleKind, string[]>,
): string {
  const preview = (label: string, values: string[], mention: "channel" | "role" | null = null) => {
    const format = (value: string) => mention === "channel" ? `<#${value}>` : mention === "role" ? `<@&${value}>` : value;
    const shown = values.slice(0, 5).map(format).join(", ") || "none";
    return `${label} (${values.length}): ${shown}${values.length > 5 ? `, +${values.length - 5} more` : ""}`;
  };
  return [
    `Mode: **${config.mode}**`, `Retention: **${config.retention_minutes} minutes**`,
    `Review channel: ${config.review_channel_id ? `<#${config.review_channel_id}>` : "not configured"}`,
    `Administrators: **${config.monitor_administrators ? "monitored" : "ignored"}**`,
    `Attachment-only: **${config.monitor_attachments ? "monitored" : "ignored"}**`,
    preview("Keywords", rules.keyword), preview("Domains", rules.domain), preview("Patterns", rules.pattern),
    preview("Included channels", rules.include_channel, "channel"), preview("Excluded channels", rules.exclude_channel, "channel"),
    preview("Excluded roles", rules.exclude_role, "role"),
  ].join("\n").slice(0, 2000);
}

export function monitoredChannelPermissionError(channelId: string, viewChannel: boolean): string | null {
  return viewChannel ? null : `I cannot monitor <#${channelId}> because I cannot view it. Add the **Deletion Monitor** role to that channel or its category and enable **View Channel**, then try again.`;
}

export function formatDiagnostics(input: {
  monitoringConfigured?: boolean;
  reviewChannelId: string | null;
  reviewPermissions?: { viewChannel: boolean; sendMessages: boolean; embedLinks: boolean; attachFiles: boolean };
  includedChannelIds: string[];
  inaccessibleChannelIds: string[];
}): string {
  const problems: string[] = [];
  if (!input.reviewChannelId) {
    problems.push("Review channel is not configured.");
  } else {
    const missing = [
      !input.reviewPermissions?.viewChannel && "View Channel",
      !input.reviewPermissions?.sendMessages && "Send Messages",
      !input.reviewPermissions?.embedLinks && "Embed Links",
      !input.reviewPermissions?.attachFiles && "Attach Files",
    ].filter(Boolean);
    if (missing.length) problems.push(`Review channel <#${input.reviewChannelId}> is missing: ${missing.join(", ")}.`);
  }
  if (input.inaccessibleChannelIds.length) {
    const shown = input.inaccessibleChannelIds.slice(0, 20).map((id) => `<#${id}>`).join(", ");
    const more = input.inaccessibleChannelIds.length > 20 ? `, +${input.inaccessibleChannelIds.length - 20} more` : "";
    problems.push(`Monitored channels I cannot view: ${shown}${more}.`);
  }
  const scope = input.monitoringConfigured === false
    ? "Monitoring is not configured. Run `/monitor setup` to choose channels."
    : input.includedChannelIds.length
    ? `Configured monitored channels: **${input.includedChannelIds.length}**.`
    : "Configured monitored channels: **all channels visible to the bot**.";
  return [
    "**Monitor diagnostics**",
    scope,
    problems.length ? "**Action required**" : "**Healthy** — required channel permissions are available.",
    ...problems.map((problem) => `• ${problem}`),
  ].join("\n").slice(0, 2000);
}

function valueChoice(option: SlashCommandSubcommandBuilder) {
  return option.addStringOption((item) => item.setName("value").setDescription("Policy").setRequired(true)
    .addChoices({ name: "Monitor", value: "monitor" }, { name: "Ignore", value: "ignore" }));
}

export function buildMonitorCommand() {
  const command = new SlashCommandBuilder().setName("monitor").setDescription("Configure deleted-message monitoring")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName("help").setDescription("Show command guidance")
      .addStringOption((option) => option.setName("topic").setDescription("Help topic").addChoices(...topics.map((topic) => ({ name: topic, value: topic })))))
    .addSubcommand((sub) => sub.setName("setup").setDescription("Guided monitored-channel setup"))
    .addSubcommand((sub) => sub.setName("review-channel").setDescription("Set the private evidence channel")
      .addChannelOption((option) => option.setName("channel").setDescription("Moderator review channel").addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((sub) => sub.setName("retention").setDescription("Set retention minutes").addIntegerOption((option) => option.setName("minutes").setDescription("Minutes (1–129600)").setMinValue(1).setMaxValue(129600).setRequired(true)))
    .addSubcommand((sub) => sub.setName("mode").setDescription("Choose capture mode").addStringOption((option) => option.setName("value").setDescription("Mode").setRequired(true).addChoices({ name: "Matching only", value: "matching" }, { name: "All", value: "all" })))
    .addSubcommand((sub) => valueChoice(sub.setName("administrators").setDescription("Monitor or ignore administrators")))
    .addSubcommand((sub) => valueChoice(sub.setName("attachments").setDescription("Monitor or ignore attachment-only messages")));
  const textGroup = (name: "keyword" | "domain") => command.addSubcommandGroup((group) => group.setName(name).setDescription(`Manage ${name} rules`)
    .addSubcommand((sub) => sub.setName("add").setDescription(`Add ${name}`).addStringOption((option) => option.setName("value").setDescription(name).setRequired(true).setMaxLength(200)))
    .addSubcommand((sub) => sub.setName("remove").setDescription(`Remove ${name}`).addStringOption((option) => option.setName("value").setDescription(name).setRequired(true).setMaxLength(200))));
  textGroup("keyword"); textGroup("domain");
  command.addSubcommandGroup((group) => group.setName("pattern").setDescription("Manage built-in patterns")
    .addSubcommand((sub) => sub.setName("add").setDescription("Enable pattern").addStringOption((option) => option.setName("value").setDescription("Pattern").setRequired(true).addChoices(...Object.keys(BUILT_IN_PATTERNS).map((name) => ({ name, value: name })))))
    .addSubcommand((sub) => sub.setName("remove").setDescription("Disable pattern").addStringOption((option) => option.setName("value").setDescription("Pattern").setRequired(true).addChoices(...Object.keys(BUILT_IN_PATTERNS).map((name) => ({ name, value: name }))))));
  command.addSubcommandGroup((group) => group.setName("channel").setDescription("Manage channel scope")
    .addSubcommand((sub) => sub.setName("include").setDescription("Include channel").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((sub) => sub.setName("exclude").setDescription("Exclude channel").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove-include").setDescription("Remove include").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove-exclude").setDescription("Remove exclusion").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true))));
  command.addSubcommandGroup((group) => group.setName("role").setDescription("Manage trusted roles")
    .addSubcommand((sub) => sub.setName("exclude").setDescription("Exclude role").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand((sub) => sub.setName("remove-exclusion").setDescription("Remove role exclusion").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))));
  return command
    .addSubcommand((sub) => sub.setName("settings").setDescription("Show bounded settings"))
    .addSubcommand((sub) => sub.setName("diagnostics").setDescription("Check bot channel permissions"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Show redacted aggregate status"))
    .addSubcommand((sub) => sub.setName("test").setDescription("Test detection rules").addStringOption((o) => o.setName("message").setDescription("Sample message").setRequired(true).setMaxLength(1000)))
    .addSubcommand((sub) => sub.setName("forget").setDescription("Permanently erase monitor data").addStringOption((o) => o.setName("confirm").setDescription("Type DELETE").setRequired(true).setMaxLength(6)));
}
