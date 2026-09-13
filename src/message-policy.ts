import { detectReasons } from "./detector.js";
import type { AttachmentSource } from "./attachments.js";
import type { MessageSnapshot } from "./capture.js";
import type { RuleKind } from "./database.js";

export type MonitorMessage = {
  id: string;
  guildId: string | null;
  channelId: string;
  content: string;
  createdAt: Date;
  author: { id: string; tag: string; displayName?: string; avatarUrl?: string | null; bot: boolean } | null;
  webhookId: string | null;
  administrator: boolean;
  roleIds: string[];
  attachments: AttachmentSource[];
  partial: boolean;
  fetch?: () => Promise<MonitorMessage>;
};

type PolicyStore = {
  hasConfig(guildId: string): boolean;
  getConfig(guildId: string): { mode: "all" | "matching"; monitor_administrators?: boolean; monitor_attachments?: boolean };
  listRules(guildId: string, kind: RuleKind): string[];
  get(messageId: string): { matched_reasons: string } | undefined;
  markDeleted(messageId: string): boolean;
};
type Coordinator = {
  capture(snapshot: MessageSnapshot): Promise<boolean>;
  afterCapture(messageId: string, action: () => Promise<void> | void): Promise<void>;
};

function storedReasons(serialized: string | undefined): string[] {
  if (!serialized) return [];
  try {
    const reasons = JSON.parse(serialized) as unknown;
    return Array.isArray(reasons) ? reasons.map(String) : [];
  } catch { return []; }
}

export function createMessageEventPolicy(deps: {
  store: PolicyStore;
  coordinator: Coordinator;
  deliver(guildId: string, messageId: string): Promise<boolean>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}) {
  async function resolve(message: MonitorMessage): Promise<MonitorMessage | undefined> {
    if (!message.partial) return message;
    try { return await message.fetch?.(); }
    catch (error) {
      deps.log?.("partial_message_fetch_failed", { messageId: message.id, guildId: message.guildId, channelId: message.channelId, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  async function capture(input: MonitorMessage, isUpdate: boolean): Promise<boolean> {
    const message = await resolve(input);
    if (!message?.guildId || !message.author || message.author.bot || message.webhookId) return false;
    const guildId = message.guildId;
    if (!deps.store.hasConfig(guildId)) return false;
    const config = deps.store.getConfig(guildId);
    if (message.administrator && !config.monitor_administrators) return false;
    if (deps.store.listRules(guildId, "exclude_role").some((id) => message.roleIds.includes(id))) return false;
    const included = deps.store.listRules(guildId, "include_channel");
    if (included.length && !included.includes(message.channelId)) return false;
    if (deps.store.listRules(guildId, "exclude_channel").includes(message.channelId)) return false;

    const current = detectReasons(message.content,
      deps.store.listRules(guildId, "keyword"), deps.store.listRules(guildId, "domain"), deps.store.listRules(guildId, "pattern"));
    if (config.monitor_attachments && message.attachments.length) current.push(`attachment (${message.attachments.length})`);
    const previous = isUpdate ? storedReasons(deps.store.get(message.id)?.matched_reasons) : [];
    const reasons = [...new Set([...previous, ...current])];
    if (config.mode === "matching" && !reasons.length) return false;
    return deps.coordinator.capture({
      messageId: message.id, guildId, channelId: message.channelId,
      authorId: message.author.id, authorTag: message.author.displayName || message.author.tag,
      authorAvatarUrl: message.author.avatarUrl ?? null, content: message.content,
      createdAt: message.createdAt, reasons, attachments: message.attachments,
    });
  }

  async function deleted(message: Pick<MonitorMessage, "id" | "guildId">): Promise<void> {
    if (!message.guildId) return;
    await deps.coordinator.afterCapture(message.id, async () => {
      if (deps.store.markDeleted(message.id)) await deps.deliver(message.guildId!, message.id);
    });
  }

  return {
    create: (message: MonitorMessage) => capture(message, false),
    update: (message: MonitorMessage) => capture(message, true),
    delete: deleted,
    bulkDelete: async (messages: Iterable<Pick<MonitorMessage, "id" | "guildId">>) => {
      for (const message of messages) await deleted(message);
    },
  };
}

export function createGuildDeleteHandler(store: { deleteGuildData(guildId: string): unknown }) {
  return async (guild: { id: string; unavailable?: boolean }) => {
    if (guild.unavailable === true) return;
    store.deleteGuildData(guild.id);
  };
}
