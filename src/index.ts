import "dotenv/config";
import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
} from "discord.js";
import { MonitorMode, RuleKind } from "./database.js";
import { BUILT_IN_PATTERNS, detectReasons, normalizeDomain } from "./detector.js";
import { downloadAttachments } from "./attachments.js";
import { CaptureCoordinator } from "./coordinator.js";
import { RETENTION_PURGE_INTERVAL_MS, loadConfig } from "./config.js";
import { deliverWithClaim } from "./delivery-claim.js";
import { deliverEvidence } from "./evidence.js";
import { createDeliveryRetryWorker } from "./retry-worker.js";
import { ActiveWorkTracker, createJsonLogger, installGracefulShutdown, safeAsyncHandler } from "./runtime.js";
import { createGuildDeleteHandler, createMessageEventPolicy } from "./message-policy.js";
import { buildMonitorCommand, executeDeferredEphemeral, executeMonitorCommand, formatDiagnostics, formatSettings } from "./monitor-command.js";
import { MessageStore } from "./database.js";
import { MonitorSetupFlow, parseSetupCustomId, renderSetupView } from "./setup-flow.js";
import { executeDirectChannelInclusion, replyForUnavailableGuild, respondToInteractionFailure } from "./interaction-routing.js";
import { toMonitorMessage } from "./discord-message.js";


const config = loadConfig();
const log = createJsonLogger(config.logLevel);
const store = new MessageStore(config.databasePath, config.retentionMinutes, {
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
const setupFlow = new MonitorSetupFlow(store);


async function inaccessibleChannelIds(guild: Guild, channelIds: string[]): Promise<string[]> {
  const me = guild.members.me ?? await guild.members.fetchMe();
  const checks = await Promise.all(channelIds.map(async (channelId) => {
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    return channel?.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel) ? null : channelId;
  }));
  return checks.filter((channelId): channelId is string => channelId !== null);
}

async function reviewPermissions(guild: Guild, channelId: string | null) {
  if (!channelId) return undefined;
  const me = guild.members.me ?? await guild.members.fetchMe();
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  const permissions = channel?.permissionsFor(me);
  return {
    viewChannel: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
    sendMessages: permissions?.has(PermissionFlagsBits.SendMessages) ?? false,
    embedLinks: permissions?.has(PermissionFlagsBits.EmbedLinks) ?? false,
    attachFiles: permissions?.has(PermissionFlagsBits.AttachFiles) ?? false,
  };
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  const path = group ? `${group} ${subcommand}` : subcommand;

  if (path === "setup") {
    const view = setupFlow.begin(guildId, interaction.user.id);
    await interaction.reply({ ...renderSetupView(view), ephemeral: true });
    return;
  }
  if (path === "diagnostics") {
    if (!interaction.guild) {
      await replyForUnavailableGuild(interaction, "run diagnostics");
      return;
    }
    await executeDeferredEphemeral(interaction, async () => {
      const guildConfig = store.getConfig(guildId);
      const includedChannelIds = store.listRules(guildId, "include_channel");
      const inaccessible = await inaccessibleChannelIds(interaction.guild!, includedChannelIds);
      return formatDiagnostics({
        monitoringConfigured: guildConfig.monitoring_configured,
        reviewChannelId: guildConfig.review_channel_id,
        reviewPermissions: await reviewPermissions(interaction.guild!, guildConfig.review_channel_id),
        includedChannelIds,
        inaccessibleChannelIds: inaccessible,
      });
    });
    return;
  }

  if (path === "help" || path === "status" || path === "forget" || path === "administrators" || path === "attachments" || path === "review-channel") {
    const values: Record<string, string | number | boolean | null | undefined> = {};
    if (path === "help") values.topic = interaction.options.getString("topic", false);
    if (path === "forget") values.confirm = interaction.options.getString("confirm", true);
    if (path === "administrators" || path === "attachments") values.value = interaction.options.getString("value", true);
    let reviewChannelPermissions: { viewChannel: boolean; sendMessages: boolean; embedLinks: boolean; attachFiles: boolean } | undefined;
    let channel: { id: string } | undefined;
    if (path === "review-channel") {
      channel = interaction.options.getChannel("channel", true);
      values.channelId = channel.id;
      const me = interaction.guild?.members.me;
      const permissions = me ? interaction.guild?.channels.cache.get(channel.id)?.permissionsFor(me) : undefined;
      reviewChannelPermissions = {
        viewChannel: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
        sendMessages: permissions?.has(PermissionFlagsBits.SendMessages) ?? false,
        embedLinks: permissions?.has(PermissionFlagsBits.EmbedLinks) ?? false,
        attachFiles: permissions?.has(PermissionFlagsBits.AttachFiles) ?? false,
      };
    }
    const result = await executeMonitorCommand({ guildId, path, values, reviewChannelPermissions }, store);
    await interaction.reply({ content: result.content, ephemeral: result.ephemeral });
    return;
  }
  if (!group && path === "retention") {
    const minutes = interaction.options.getInteger("minutes", true);
    store.setRetention(guildId, minutes);
    await interaction.reply({ content: `Captured messages will be retained for ${minutes} minute(s).`, ephemeral: true });
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
  if (!remove && kind === "include_channel") {
    await executeDirectChannelInclusion(
      interaction,
      guildId,
      value,
      (id, ruleKind, channelId) => store.addRule(id, ruleKind, channelId),
      inaccessibleChannelIds,
    );
    return;
  }
  const applyRule = async (): Promise<string> => {
    const changed = remove ? store.removeRule(guildId, kind, value) : store.addRule(guildId, kind, value);
    return changed ? `Setting ${remove ? "removed" : "added"}.` : `That setting was already ${remove ? "absent" : "configured"}.`;
  };
  await interaction.reply({ content: await applyRule(), ephemeral: true });
}

async function handleSetupComponent(interaction: ButtonInteraction | ChannelSelectMenuInteraction): Promise<void> {
  if (!interaction.guildId) return;
  if (!interaction.guild) {
    await replyForUnavailableGuild(interaction, "continue setup");
    return;
  }
  await interaction.deferUpdate();
  const setupAction = parseSetupCustomId(interaction.customId);
  if (!setupAction) {
    await interaction.editReply(renderSetupView({ kind: "expired" }));
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    setupFlow.cancel(interaction.guildId, interaction.user.id, setupAction.flowId);
    await interaction.editReply({ content: "Manage Server permission is required to run monitor setup.", components: [] });
    return;
  }

  let view;
  if (interaction.isChannelSelectMenu() && setupAction.action === "channels") {
    const inaccessible = await inaccessibleChannelIds(interaction.guild, interaction.values);
    view = setupFlow.select(interaction.guildId, interaction.user.id, setupAction.flowId, interaction.values, inaccessible);
  } else if (interaction.isButton() && setupAction.action === "cancel") {
    view = setupFlow.cancel(interaction.guildId, interaction.user.id, setupAction.flowId);
  } else {
    const selected = setupFlow.selectedChannels(interaction.guildId, interaction.user.id, setupAction.flowId);
    const inaccessible = selected ? await inaccessibleChannelIds(interaction.guild, selected) : [];
    view = !selected ? { kind: "expired" as const } : setupAction.action === "confirm"
      ? setupFlow.confirm(interaction.guildId, interaction.user.id, setupAction.flowId, selected, inaccessible)
      : setupFlow.recheck(interaction.guildId, interaction.user.id, setupAction.flowId, selected, inaccessible);
  }
  await interaction.editReply(renderSetupView(view));
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
  const isSetupComponent = (interaction.isChannelSelectMenu() || interaction.isButton()) && parseSetupCustomId(interaction.customId) !== undefined;
  if (interaction.isChatInputCommand() && interaction.commandName === "monitor") {
    await handleCommand(interaction).catch(async (error: unknown) => {
      log("command_failed", { error: error instanceof Error ? error.message : String(error) }, "error");
      const response = { content: "The setting could not be updated. Check the bot logs.", ephemeral: true } as const;
      await respondToInteractionFailure(interaction, response);
    });
  } else if (isSetupComponent) {
    await handleSetupComponent(interaction as ButtonInteraction | ChannelSelectMenuInteraction).catch(async (error: unknown) => {
      log("setup_failed", { error: error instanceof Error ? error.message : String(error) }, "error");
      const response = { content: "Setup could not be completed. Run `/monitor setup` again.", components: [] };
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply({ ...response, ephemeral: true });
    });
  }
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
}, RETENTION_PURGE_INTERVAL_MS);
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
