import type { AttachmentSource } from "./attachments.js";
import type { StoredAttachment, StoredMessage } from "./database.js";

export type MessageSnapshot = {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  authorAvatarUrl?: string | null;
  content: string;
  createdAt: Date;
  reasons: string[];
  attachments: AttachmentSource[];
};
type CaptureStore = { save(message: StoredMessage, attachments: StoredAttachment[]): void };
type AttachmentDownloader = (messageId: string, attachments: AttachmentSource[]) => Promise<StoredAttachment[]>;

export async function captureMessage(snapshot: MessageSnapshot, store: CaptureStore, download: AttachmentDownloader): Promise<void> {
  const attachments = await download(snapshot.messageId, snapshot.attachments);
  store.save({
    message_id: snapshot.messageId,
    guild_id: snapshot.guildId,
    channel_id: snapshot.channelId,
    author_id: snapshot.authorId,
    author_tag: snapshot.authorTag,
    author_avatar_url: snapshot.authorAvatarUrl ?? null,
    content: snapshot.content,
    attachment_urls: JSON.stringify(snapshot.attachments.map((attachment) => attachment.url)),
    matched_reasons: JSON.stringify(snapshot.reasons),
    created_at: snapshot.createdAt.toISOString(),
  }, attachments);
}
