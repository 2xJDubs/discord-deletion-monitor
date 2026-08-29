import "dotenv/config";
import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
} from "discord.js";
import { MonitorMode, RuleKind } from "./database.js";
import { BUILT_IN_PATTERNS, detectReasons, normalizeDomain } from "./detector.js";
import { downloadAttachments } from "./attachments.js";
import { CaptureCoordinator } from "./coordinator.js";
import { loadConfig } from "./config.js";
import { deliverWithClaim } from "./delivery-claim.js";
import { deliverEvidence } from "./evidence.js";
import { createDeliveryRetryWorker } from "./retry-worker.js";
import { ActiveWorkTracker, createJsonLogger, installGracefulShutdown, safeAsyncHandler } from "./runtime.js";
import { createGuildDeleteHandler, createMessageEventPolicy, type MonitorMessage } from "./message-policy.js";
import { buildMonitorCommand, executeMonitorCommand, formatSettings } from "./monitor-command.js";
import { MessageStore } from "./database.js";


const config = loadConfig();
const log = createJsonLogger(config.logLevel);
const store = new MessageStore(config.databasePath, config.retentionHours, {
  busyTimeoutMs: config.databaseBusyTimeoutMs,
  attachmentQuotaBytes: config.storedAttachmentMaxBytes,
});
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const work = new ActiveWorkTracker();
const coordinator = new CaptureCoordinator(
  store,
  (messageId, attachments, signal) => downloadAttachments(messageId, attachments, {
    perFileBytes: config.attachmentMaxFileBytes,
    totalBytes: config.attachmentMaxTotalBytes,
    timeoutMs: config.attachmentDownloadTimeoutMs,
    signal,
  }, fetch, (event, fields) => log(event, fields, "warn")),
  { concurrency: config.captureConcurrency, maxQueued: config.captureQueueMax },
);

const fetchReviewChannel = async (channelId: string) => {
  const channel = await client.channels.fetch(channelId);
  return channel?.isSendable() ? channel : null;
};
const deliverClaimed = (guildId: string, messageId: string, claimToken: string) => deliverEvidence(
  guildId,
  messageId,
  claimToken,
  store,
  fetchReviewChannel,
  (event, fields) => log(event, fields, event.endsWith("failed") ? "error" : "info"),
);
const deliver = (guildId: string, messageId: string) => deliverWithClaim(
  guildId,
  messageId,
  store,
  deliverClaimed,
);
const retryWorker = createDeliveryRetryWorker({
  listDuePending: (now, limit) => store.listDuePending(now, limit),
  deliver,
  intervalMs: config.deliveryRetryIntervalMs,
  batchSize: config.deliveryRetryBatchSize,
  runWork: (task) => work.run(task),
  log,
});

const command = buildMonitorCommand();
const policy = createMessageEventPolicy({
  store,
  coordinator,
  deliver,
  log: (event, fields) => log(event, fields, "warn"),
});
const handleGuildDelete = createGuildDeleteHandler(store);

function toMonitorMessage(message: {
  id: string; guildId: string | null; channelId: string; content: string; createdAt: Date;
  author: { id: string; tag: string; bot: boolean } | null; webhookId: string | null;
  member: { permissions: { has(flag: bigint): boolean }; roles: { cache: Map<string, unknown> } } | null;
  attachments: Iterable<{ id: string; url: string; name: string; contentType: string | null; size: number }>;
  partial: boolean;
  fetch?: () => Promise<unknown>;
}): MonitorMessage {
  const sources = [...message.attachments].map((attachment) => ({
    id: attachment.id, url: attachment.url, name: attachment.name, contentType: attachment.contentType, size: attachment.size,
  }));
  return {
    id: message.id, guildId: message.guildId, channelId: message.channelId, content: message.content,
    createdAt: message.createdAt, author: message.author,
    webhookId: message.webhookId,
    administrator: message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
    roleIds: message.member ? [...message.member.roles.cache].map(([id]) => id as string) : [],
    attachments: sources,
    partial: message.partial,
    fetch: message.fetch ? async () => toMonitorMessage(await message.fetch!() as never) : undefined,
  };
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  const path = group ? `${group} ${subcommand}` : subcommand;

  if (path === "help" || path === "status" || path === "forget" || path === "administrators" || path === "attachments" || path === "review-channel") {
    const values: Record<string, string | number | boolean | null | undefined> = {};
    if (path === "help") values.topic = interaction.options.getString("topic", false);
    if (path === "forget") values.confirm = interaction.options.getString("confirm", true);
    if (path === "administrators" || path === "attachments") values.value = interaction.options.getString("value", true);
    let reviewChannelPermissions: { viewChannel: boolean; sendMessages: boolean; attachFiles: boolean } | undefined;
    let channel: { id: string } | undefined;
    if (path === "review-channel") {
      channel = interaction.options.getChannel("channel", true);
      values.channelId = channel.id;
      const me = interaction.guild?.members.me;
      const permissions = me ? interaction.guild?.channels.cache.get(channel.id)?.permissionsFor(me) : undefined;
      reviewChannelPermissions = {
        viewChannel: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
        sendMessages: permissions?.has(PermissionFlagsBits.SendMessages) ?? false,
        attachFiles: permissions?.has(PermissionFlagsBits.AttachFiles) ?? false,
      };
    }
    const result = await executeMonitorCommand({ guildId, path, values, reviewChannelPermissions }, store);
    await interaction.reply({ content: result.content, ephemeral: result.ephemeral });
    return;
  }
  if (!group && path === "retention") {
    const hours = interaction.options.getInteger("hours", true);
    store.setRetention(guildId, hours);
    await interaction.reply({ content: `Matching messages will be retained for ${hours} hour(s).`, ephemeral: true });
    return;
  }
  if (!group && path === "mode") {
    const mode = interaction.options.getString("value", true) as MonitorMode;
    store.setMode(guildId, mode);
    await interaction.reply({ content: `Monitoring mode set to **${mode}**.`, ephemeral: true });
    return;
  }
  if (!group && path === "test") {
    const message = interaction.options.getString("message", true);
    const reasons = detectReasons(message, store.listRules(guildId, "keyword"), store.listRules(guildId, "domain"), store.listRules(guildId, "pattern"));
    await interaction.reply({ content: reasons.length ? `Would be saved: ${reasons.join(", ")}` : "Would not be saved in matching mode.", ephemeral: true });
    return;
  }
  if (!group && path === "settings") {
    const guildConfig = store.getConfig(guildId);
    const rules: Record<RuleKind, string[]> = {
      keyword: store.listRules(guildId, "keyword"), domain: store.listRules(guildId, "domain"), pattern: store.listRules(guildId, "pattern"),
      include_channel: store.listRules(guildId, "include_channel"), exclude_channel: store.listRules(guildId, "exclude_channel"),
      exclude_role: store.listRules(guildId, "exclude_role"),
    };
    await interaction.reply({ ephemeral: true, content: formatSettings(guildConfig, rules) });
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

function trackedAsyncHandler<Args extends unknown[]>(
  event: string,
  handler: (...args: Args) => Promise<void> | void,
): (...args: Args) => void {
  const safe = safeAsyncHandler(event, handler, log);
  return (...args) => { void work.run(() => safe(...args)); };
}

client.once(Events.ClientReady, trackedAsyncHandler("client_ready", async (readyClient) => {
  const rest = new REST().setToken(config.token);
  await rest.put(Routes.applicationCommands(readyClient.user.id), { body: [command.toJSON()] });
  log("client_ready", { userTag: readyClient.user.tag, guildCount: readyClient.guilds.cache.size });
}));

client.on(Events.InteractionCreate, trackedAsyncHandler("interaction_create", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "monitor") return;
  await handleCommand(interaction).catch(async (error: unknown) => {
    log("command_failed", { error: error instanceof Error ? error.message : String(error) }, "error");
    const response = { content: "The setting could not be updated. Check the bot logs.", ephemeral: true } as const;
    if (interaction.replied || interaction.deferred) await interaction.followUp(response);
    else await interaction.reply(response);
  });
}));

client.on(Events.MessageCreate, trackedAsyncHandler("message_create", async (message) => {
  await policy.create(toMonitorMessage(message as never));
}));

client.on(Events.MessageUpdate, trackedAsyncHandler("message_update", async (_oldMessage, newMessage) => {
  await policy.update(toMonitorMessage(newMessage as never));
}));

client.on(Events.MessageDelete, trackedAsyncHandler("message_delete", async (message) => {
  await policy.delete({ id: message.id, guildId: message.guildId });
}));

client.on(Events.MessageBulkDelete, trackedAsyncHandler("message_bulk_delete", async (messages) => {
  await policy.bulkDelete([...messages.values()].map((message) => ({ id: message.id, guildId: message.guildId })));
}));

client.on(Events.GuildDelete, trackedAsyncHandler("guild_delete", async (guild) => {
  await handleGuildDelete({ id: guild.id, unavailable: !guild.available });
}));

const purgeTimer = setInterval(() => {
  void work.run(() => {
    try {
      const removed = store.purgeExpired(new Date());
      if (removed) log("evidence_purged", { count: removed });
    } catch (error) {
      log("purge_failed", { error: error instanceof Error ? error.message : String(error) }, "error");
    }
  });
}, 15 * 60 * 1000);
purgeTimer.unref();
const stopBackgroundWork = () => {
  clearInterval(purgeTimer);
  retryWorker.stop();
  coordinator.stop();
};
installGracefulShutdown(client, store, log, process, stopBackgroundWork, {
  work,
  drainTimeoutMs: config.shutdownDrainTimeoutMs,
});

try {
  await client.login(config.token);
  retryWorker.start();
} catch (error) {
  work.stopAccepting();
  stopBackgroundWork();
  await work.drain(config.shutdownDrainTimeoutMs);
  store.close();
  log("login_failed", { error: error instanceof Error ? error.message : String(error) }, "error");
  process.exitCode = 1;
}
