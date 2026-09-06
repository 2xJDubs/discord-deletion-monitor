import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} from "discord.js";

export const SETUP_CUSTOM_IDS = {
  channels: "monitor:setup:channels",
  recheck: "monitor:setup:recheck",
  confirm: "monitor:setup:confirm",
  cancel: "monitor:setup:cancel",
} as const;
export type SetupAction = keyof typeof SETUP_CUSTOM_IDS;

export function parseSetupCustomId(customId: string): { action: SetupAction; flowId: string } | undefined {
  for (const [action, prefix] of Object.entries(SETUP_CUSTOM_IDS) as Array<[SetupAction, string]>) {
    if (!customId.startsWith(`${prefix}:`)) continue;
    const flowId = customId.slice(prefix.length + 1);
    if (/^[A-Za-z0-9_-]{6,32}$/.test(flowId)) return { action, flowId };
  }
  return undefined;
}

function setupCustomId(action: SetupAction, flowId: string): string {
  const customId = `${SETUP_CUSTOM_IDS[action]}:${flowId}`;
  if (customId.length > 100) throw new Error("Setup custom ID exceeds Discord's 100-character limit");
  return customId;
}

type SetupStore = {
  listRules(guildId: string, kind: "include_channel"): string[];
  applySetup(guildId: string, channelIds: string[]): void;
};

type ActiveSetupView =
  | { kind: "select"; flowId: string; selectedChannelIds: string[] }
  | { kind: "permissions"; flowId: string; selectedChannelIds: string[]; inaccessibleChannelIds: string[] }
  | { kind: "confirm"; flowId: string; selectedChannelIds: string[] };
export type SetupView = ActiveSetupView
  | { kind: "complete"; selectedChannelIds: string[] }
  | { kind: "cancelled" }
  | { kind: "expired" }
  | { kind: "invalid"; reason: string };

type SetupSession = {
  guildId: string;
  userId: string;
  flowId: string;
  selectedChannelIds: string[];
  expiresAt: number;
};

export class MonitorSetupFlow {
  private readonly sessions = new Map<string, SetupSession>();
  private readonly currentFlows = new Map<string, { userId: string; flowId: string }>();

  constructor(
    private readonly store: SetupStore,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
    private readonly createFlowId: () => string = () => randomBytes(9).toString("base64url"),
  ) {}

  private key(guildId: string, userId: string, flowId: string): string {
    return `${guildId}:${userId}:${flowId}`;
  }

  private session(guildId: string, userId: string, flowId: string): SetupSession | undefined {
    const current = this.currentFlows.get(guildId);
    if (current?.userId !== userId || current.flowId !== flowId) return undefined;
    const key = this.key(guildId, userId, flowId);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      this.currentFlows.delete(guildId);
      return undefined;
    }
    return session;
  }

  begin(guildId: string, userId: string): Extract<ActiveSetupView, { kind: "select" }> {
    const flowId = this.createFlowId();
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(flowId)) throw new Error("Setup flow IDs must be 6-32 URL-safe characters");
    const previous = this.currentFlows.get(guildId);
    if (previous) this.sessions.delete(this.key(guildId, previous.userId, previous.flowId));
    const selectedChannelIds = this.store.listRules(guildId, "include_channel").slice(0, 25);
    this.sessions.set(this.key(guildId, userId, flowId), {
      guildId,
      userId,
      flowId,
      selectedChannelIds,
      expiresAt: this.now() + this.ttlMs,
    });
    this.currentFlows.set(guildId, { userId, flowId });
    return { kind: "select", flowId, selectedChannelIds };
  }

  select(guildId: string, userId: string, flowId: string, channelIds: string[], inaccessibleChannelIds: string[]): SetupView {
    const session = this.session(guildId, userId, flowId);
    if (!session) return { kind: "expired" };
    const selectedChannelIds = [...new Set(channelIds)];
    if (selectedChannelIds.length < 1 || selectedChannelIds.length > 25) {
      return { kind: "invalid", reason: "Select between 1 and 25 channels." };
    }
    session.selectedChannelIds = selectedChannelIds;
    return this.permissionOrConfirmation(session, selectedChannelIds, inaccessibleChannelIds);
  }

  recheck(guildId: string, userId: string, flowId: string, selectedChannelIds: string[], inaccessibleChannelIds: string[]): SetupView {
    const session = this.session(guildId, userId, flowId);
    if (!session) return { kind: "expired" };
    return this.permissionOrConfirmation(session, selectedChannelIds, inaccessibleChannelIds);
  }

  confirm(guildId: string, userId: string, flowId: string, selectedChannelIds: string[], inaccessibleChannelIds: string[]): SetupView {
    const session = this.session(guildId, userId, flowId);
    if (!session) return { kind: "expired" };
    const snapshot = [...selectedChannelIds];
    const checked = this.permissionOrConfirmation(session, snapshot, inaccessibleChannelIds);
    if (checked.kind !== "confirm") return checked;
    this.store.applySetup(guildId, snapshot);
    this.sessions.delete(this.key(guildId, userId, flowId));
    this.currentFlows.delete(guildId);
    return { kind: "complete", selectedChannelIds: snapshot };
  }

  cancel(guildId: string, userId: string, flowId: string): SetupView {
    const session = this.session(guildId, userId, flowId);
    if (!session) return { kind: "expired" };
    this.sessions.delete(this.key(guildId, userId, flowId));
    this.currentFlows.delete(guildId);
    return { kind: "cancelled" };
  }

  selectedChannels(guildId: string, userId: string, flowId: string): string[] | undefined {
    const selected = this.session(guildId, userId, flowId)?.selectedChannelIds;
    return selected ? [...selected] : undefined;
  }

  private permissionOrConfirmation(session: SetupSession, selectedChannelIds: string[], inaccessibleChannelIds: string[]): ActiveSetupView {
    const inaccessible = new Set(inaccessibleChannelIds);
    const blocked = selectedChannelIds.filter((id) => inaccessible.has(id));
    return blocked.length
      ? { kind: "permissions", flowId: session.flowId, selectedChannelIds, inaccessibleChannelIds: blocked }
      : { kind: "confirm", flowId: session.flowId, selectedChannelIds };
  }
}

type SetupPayload = {
  content: string;
  components: Array<ActionRowBuilder<ChannelSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>>;
};

function buttons(...items: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...items);
}

export function renderSetupView(view: SetupView): SetupPayload {
  if (view.kind === "select") {
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(setupCustomId("channels", view.flowId))
      .setPlaceholder("Choose 1–25 monitored channels")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(25);
    if (view.selectedChannelIds.length) menu.setDefaultChannels(...view.selectedChannelIds);
    return {
      content: "**Monitor setup — Channels**\nSelect the channels to monitor. This will replace the current monitored-channel list only after you confirm.",
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu)],
    };
  }
  if (view.kind === "permissions") {
    return {
      content: [
        "**Monitor setup — Permission required**",
        "I cannot view these selected channels:",
        view.inaccessibleChannelIds.map((id) => `• <#${id}>`).join("\n"),
        "Add the **Deletion Monitor** role to each channel or its category and enable **View Channel**, then press **Recheck permissions**.",
      ].join("\n").slice(0, 2000),
      components: [buttons(
        new ButtonBuilder().setCustomId(setupCustomId("recheck", view.flowId)).setLabel("Recheck permissions").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(setupCustomId("cancel", view.flowId)).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      )],
    };
  }
  if (view.kind === "confirm") {
    return {
      content: [
        "**Monitor setup — Confirm replacement**",
        `The bot can view all **${view.selectedChannelIds.length}** selected channel(s):`,
        view.selectedChannelIds.map((id) => `• <#${id}>`).join("\n"),
        "Press **Confirm** to replace the current monitored-channel list.",
      ].join("\n").slice(0, 2000),
      components: [buttons(
        new ButtonBuilder().setCustomId(setupCustomId("confirm", view.flowId)).setLabel("Confirm").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(setupCustomId("cancel", view.flowId)).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      )],
    };
  }
  if (view.kind === "complete") {
    return { content: `Setup complete. Monitoring **${view.selectedChannelIds.length}** channel(s) in **all-message mode**.`, components: [] };
  }
  if (view.kind === "cancelled") return { content: "Monitor setup cancelled. No channel settings were changed.", components: [] };
  if (view.kind === "invalid") return { content: view.reason, components: [] };
  return { content: "This setup session expired or belongs to another user. Run `/monitor setup` again.", components: [] };
}
