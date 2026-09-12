import { PermissionFlagsBits } from "discord.js";
import type { MonitorMessage } from "./message-policy.js";

export type DiscordMessageLike = {
  id: string;
  guildId: string | null;
  channelId: string;
  content: string;
  createdAt: Date;
  author: { id: string; tag: string; displayName?: string; bot: boolean; displayAvatarURL(options: { extension: "png"; size: 64 }): string } | null;
  webhookId: string | null;
  member: { displayName?: string; displayAvatarURL(options: { extension: "png"; size: 64 }): string; permissions: { has(flag: bigint): boolean }; roles: { cache: Map<string, unknown> } } | null;
  attachments: Iterable<{ id: string; url: string; name: string; contentType: string | null; size: number }>;
  partial: boolean;
  fetch?: () => Promise<unknown>;
};

export function toMonitorMessage(message: DiscordMessageLike): MonitorMessage {
  const attachments = [...message.attachments].map((attachment) => ({
    id: attachment.id, url: attachment.url, name: attachment.name, contentType: attachment.contentType, size: attachment.size,
  }));
  const avatarOptions = { extension: "png", size: 64 } as const;
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    content: message.content,
    createdAt: message.createdAt,
    author: message.author ? {
      id: message.author.id,
      tag: message.author.tag,
      displayName: message.member?.displayName || message.author.displayName || message.author.tag,
      avatarUrl: message.member?.displayAvatarURL(avatarOptions) ?? message.author.displayAvatarURL(avatarOptions),
      bot: message.author.bot,
    } : null,
    webhookId: message.webhookId,
    administrator: message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
    roleIds: message.member ? [...message.member.roles.cache].map(([id]) => id) : [],
    attachments,
    partial: message.partial,
    fetch: message.fetch ? async () => toMonitorMessage(await message.fetch!() as DiscordMessageLike) : undefined,
  };
}
