import { basename } from "node:path";
import type { StoredEvidence } from "./database.js";
import type { EventLogger } from "./attachments.js";

export type EvidenceFile = { attachment: Buffer; name: string; description?: string };
export type EvidencePayload = {
  content: string;
  allowedMentions: { parse: []; repliedUser: false };
  files: EvidenceFile[];
};

type EvidenceStore = {
  getEvidence(messageId: string): StoredEvidence | undefined;
  getConfig(guildId: string): { review_channel_id: string | null };
  removeClaimed(messageId: string, claimToken: string): boolean;
  renewDeliveryClaim(messageId: string, claimToken: string, now?: Date, leaseMs?: number): boolean;
  isClaimDeliverable(messageId: string, claimToken: string, now?: Date): boolean;
  advanceDeliveryBatch(messageId: string, claimToken: string, nextBatchIndex: number): boolean;
  scheduleRetry(messageId: string, error: unknown, now: Date, options: { claimToken: string }): boolean | void;
};
type SendableChannel = { isSendable(): boolean; send(payload: EvidencePayload): Promise<unknown> };
type FetchChannel = (channelId: string) => Promise<SendableChannel | null>;
type DeliveryLeaseOptions = {
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => Date;
};

function safeFilename(filename: string, fallback: string): string {
  const cleaned = basename(filename)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .slice(0, 200);
  return cleaned || fallback;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeDiscordMarkdown(value: string): string {
  return value
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replace(/<@/g, "<\u200b@")
    .replace(/[\\`*_[\]()~<>#+\-=|{}.!]/g, "\\$&");
}

function evidenceParts(evidence: StoredEvidence): { content: string; files: EvidenceFile[] } {
  const { message, attachments } = evidence;
  let reasons: string[] = [];
  try { reasons = JSON.parse(message.matched_reasons) as string[]; } catch { reasons = ["unreadable stored reasons"]; }
  const timestamp = Math.floor(new Date(message.created_at).getTime() / 1000);
  const header = [
    "**Deleted message captured**",
    `Author: ${escapeDiscordMarkdown(message.author_tag)} (<@${message.author_id}> \`${message.author_id}\`)`,
    `Channel: <#${message.channel_id}>`,
    `Posted: <t:${timestamp}:F>`,
    reasons.length ? `Matched: ${reasons.map((reason) => escapeDiscordMarkdown(String(reason))).join(", ")}` : "Matched: all-message mode",
  ].join("\n");
  const attachmentFiles: EvidenceFile[] = attachments.map((attachment) => ({
    attachment: attachment.bytes,
    name: safeFilename(attachment.filename, `attachment-${attachment.attachment_id}`),
    description: `Preserved attachment ${attachment.attachment_id}`,
  }));
  const inline = `${header}\nContent:\n${message.content ? escapeDiscordMarkdown(message.content) : "*(no text content)*"}`;
  if (inline.length <= 2000) return { content: inline, files: attachmentFiles };
  const name = `deleted-message-${safeFilename(message.message_id, "unknown")}.txt`;
  return {
    content: `${header}\nContent: full UTF-8 text attached as ${name}.`.slice(0, 2000),
    files: [{ attachment: Buffer.from(message.content, "utf8"), name, description: "Full deleted message content" }, ...attachmentFiles],
  };
}

export function buildEvidencePayloads(evidence: StoredEvidence): EvidencePayload[] {
  const { content, files } = evidenceParts(evidence);
  const batches: EvidencePayload[] = [];
  for (let offset = 0; offset < Math.max(1, files.length); offset += 10) {
    batches.push({
      content: offset === 0 ? content : `**Deleted message captured (files continued)**\nMessage ID: \`${evidence.message.message_id}\``,
      allowedMentions: { parse: [], repliedUser: false },
      files: files.slice(offset, offset + 10),
    });
  }
  return batches;
}

/** Compatibility helper for callers that only need the first payload. */
export function buildEvidencePayload(evidence: StoredEvidence): EvidencePayload {
  return buildEvidencePayloads(evidence)[0];
}

export async function deliverEvidence(
  guildId: string,
  messageId: string,
  claimToken: string,
  store: EvidenceStore,
  fetchChannel: FetchChannel,
  log: EventLogger = () => undefined,
  leaseOptions: DeliveryLeaseOptions = {},
): Promise<boolean> {
  const evidence = store.getEvidence(messageId);
  if (!evidence) return false;
  const reviewChannelId = store.getConfig(guildId).review_channel_id;
  if (!reviewChannelId) {
    const reason = new Error("review_channel_not_configured");
    store.scheduleRetry(messageId, reason, new Date(), { claimToken });
    log("evidence_delivery_deferred", { guildId, messageId, reason: reason.message });
    return false;
  }
  let heartbeat: NodeJS.Timeout | undefined;
  let claimLost = false;
  const leaseMs = leaseOptions.leaseMs ?? 5 * 60_000;
  const heartbeatMs = leaseOptions.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3));
  const now = leaseOptions.now ?? (() => new Date());
  const renewClaim = (): boolean => {
    if (claimLost) return false;
    try {
      if (store.renewDeliveryClaim(messageId, claimToken, now(), leaseMs)) return true;
    } catch {
      // A renewal failure must fence this worker just like an ownership change.
    }
    claimLost = true;
    return false;
  };
  try {
    const channel = await fetchChannel(reviewChannelId);
    if (!channel?.isSendable()) {
      const reason = new Error("review_channel_unavailable");
      store.scheduleRetry(messageId, reason, new Date(), { claimToken });
      log("evidence_delivery_deferred", { guildId, messageId, reason: reason.message });
      return false;
    }
    const payloads = buildEvidencePayloads(evidence);
    const firstPendingBatch = evidence.message.delivery_batch_index ?? 0;
    heartbeat = setInterval(() => { renewClaim(); }, heartbeatMs);
    heartbeat.unref();
    for (let index = firstPendingBatch; index < payloads.length; index += 1) {
      if (!renewClaim()) throw new Error("delivery_claim_lost");
      if (!store.isClaimDeliverable(messageId, claimToken, now())) {
        log("evidence_delivery_fenced", { guildId, messageId, reason: "retention_or_ownership_lost" });
        return false;
      }
      await channel.send(payloads[index]);
      if (claimLost) throw new Error("delivery_claim_lost");
      if (!store.advanceDeliveryBatch(messageId, claimToken, index + 1)) throw new Error("delivery_claim_lost");
    }
    if (!store.removeClaimed(messageId, claimToken)) throw new Error("delivery_claim_lost");
    log("evidence_delivered", { guildId, messageId, attachmentCount: evidence.attachments.length, batchCount: payloads.length });
    return true;
  } catch (error) {
    store.scheduleRetry(messageId, error, new Date(), { claimToken });
    log("evidence_delivery_failed", { guildId, messageId, error: errorMessage(error) });
    return false;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
