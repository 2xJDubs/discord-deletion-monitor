import { basename } from "node:path";
import type { StoredEvidence } from "./database.js";
import type { EventLogger } from "./attachments.js";

export type EvidenceFile = { attachment: Buffer; name: string; description?: string };
export type EvidenceEmbed = {
  color: number;
  author: { name: string; icon_url?: string };
  description: string;
  fields: Array<{ name: string; value: string }>;
  footer: { text: string };
  timestamp?: string;
};
export type EvidencePayload = {
  content: string;
  allowedMentions: { parse: []; repliedUser: false };
  files: EvidenceFile[];
  embeds: EvidenceEmbed[];
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

function safeFilename(filename: string, fallback: string, limit = 200): string {
  const clean = (candidate: string) => {
    const pathSafe = basename(candidate.replace(/\\/g, "/"))
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "_");
    const cleaned = [...sanitizePresentation(pathSafe, "").value]
      .slice(0, limit)
      .join("")
      .replace(/[\u200d\ufe0e\ufe0f]$/u, "");
    return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "";
  };
  return clean(filename) || clean(fallback) || "file";
}

function fullContentFilename(messageId: string): string {
  const prefix = "deleted-message-";
  const suffix = ".txt";
  const messageIdLimit = 200 - [...prefix, ...suffix].length;
  return `${prefix}${safeFilename(messageId, "unknown", messageIdLimit)}${suffix}`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function neutralizeMentions(value: string): string {
  return value
    .replace(/@(everyone|here)/gi, "@ $1")
    .replace(/<@/g, "< @");
}

function escapeDiscordMarkdown(value: string): string {
  return neutralizeMentions(value)
    .replace(/[\\`*_[\]()~<>#+\-=|{}.!]/g, "\\$&");
}

function escapeInlineFilenameMarkdown(value: string): string {
  return neutralizeMentions(value).replace(/[\\`*_[\]()~<>|]/g, "\\$&");
}

// Unicode Default_Ignorable_Code_Point plus the full Format category cover format
// controls, fillers, reserved format characters, tags, and other characters that
// can change or conceal presentation. Line/paragraph separators are also unsafe
// where they can break a Discord surface.
const UNSAFE_PRESENTATION_CODE_POINT = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\p{Cf}\u2028\u2029\ufff9-\ufffb]/u;
const EMOJI = /\p{Emoji}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const EMOJI_VARIATION_SELECTOR = /[\ufe0e\ufe0f]/u;

function isDeliberateEmojiControl(characters: string[], index: number): boolean {
  const character = characters[index];
  if (EMOJI_VARIATION_SELECTOR.test(character)) {
    return index > 0 && EMOJI.test(characters[index - 1]);
  }
  if (character !== "\u200d" || index === 0 || index === characters.length - 1) return false;
  let previous = index - 1;
  while (previous >= 0 && (EMOJI_VARIATION_SELECTOR.test(characters[previous]) || EMOJI_MODIFIER.test(characters[previous]))) {
    previous -= 1;
  }
  return previous >= 0
    && EXTENDED_PICTOGRAPHIC.test(characters[previous])
    && EXTENDED_PICTOGRAPHIC.test(characters[index + 1]);
}

function sanitizePresentation(value: string, replacement: string, allowTextWhitespace = false): { value: string; changed: boolean } {
  const characters = [...value];
  let changed = false;
  const sanitized = characters.map((character, index) => {
    if (allowTextWhitespace && ["\t", "\n"].includes(character)) return character;
    if (!UNSAFE_PRESENTATION_CODE_POINT.test(character) || isDeliberateEmojiControl(characters, index)) return character;
    changed = true;
    return replacement;
  }).join("");
  return { value: sanitized, changed };
}
function truncateUtf16(value: string, limit: number): string {
  const segments = graphemeClusters(value);
  let result = "";
  for (const cluster of segments) {
    if (result.length + cluster.length > limit) {
      if (!result && limit > 0) {
        for (const codePoint of cluster) {
          if (result.length + codePoint.length > limit) break;
          result += codePoint;
        }
        result = result.replace(/[\u200d\ufe0e\ufe0f]$/u, "");
        if (!result) result = "�";
      }
      break;
    }
    result += cluster;
  }
  return result;
}

// Cached across calls: constructing an Intl.Segmenter is comparatively
// expensive, and every truncation on the evidence path benefits from a
// single shared grapheme-cluster segmenter when the runtime supports one.
const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

// A conservative fallback set of Unicode joining/selecting code points that must
// never end a truncated string on their own: a trailing ZWJ or variation
// selector without its paired base/following character is an invalid, dangling
// contextual sequence rather than a complete emoji/ZWJ/VS/keycap cluster.
const DANGLING_JOIN_OR_SELECT = /[\u200d\ufe0e\ufe0f]$/u;
const KEYCAP_COMBINING_ENCLOSING = "\u20e3";

/**
 * Splits `value` into grapheme clusters (one entry per fully composed visual
 * character, including multi-code-point emoji/ZWJ/VS/keycap sequences).
 * Uses Intl.Segmenter when the runtime supports it; otherwise falls back to a
 * deterministic code-point-level split that additionally refuses to end a
 * cluster on a dangling ZWJ or variation selector, so a boundary can never
 * land inside a joined emoji sequence.
 */
function graphemeClusters(value: string): string[] {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(value)].map((entry) => entry.segment);
  }
  const codePoints = [...value];
  const clusters: string[] = [];
  for (const codePoint of codePoints) {
    const previous = clusters[clusters.length - 1];
    if (
      previous !== undefined
      && (codePoint === "\u200d" || EMOJI_VARIATION_SELECTOR.test(codePoint) || codePoint === KEYCAP_COMBINING_ENCLOSING)
      && !DANGLING_JOIN_OR_SELECT.test(previous)
    ) {
      clusters[clusters.length - 1] = previous + codePoint;
      continue;
    }
    if (previous !== undefined && DANGLING_JOIN_OR_SELECT.test(previous) && !EMOJI_VARIATION_SELECTOR.test(codePoint)) {
      // The previous cluster ended in a ZWJ awaiting its next pictographic
      // partner: fold this code point in only if it can complete the
      // sequence, otherwise start a fresh cluster.
      clusters[clusters.length - 1] = previous + codePoint;
      continue;
    }
    clusters.push(codePoint);
  }
  // A final cluster ending in a dangling ZWJ or variation selector never
  // received its pairing code point (the source string itself ended mid
  // sequence): trim the dangling suffix so no consumer downstream ever sees it.
  const last = clusters[clusters.length - 1];
  if (last !== undefined && DANGLING_JOIN_OR_SELECT.test(last)) {
    const trimmed = last.replace(DANGLING_JOIN_OR_SELECT, "");
    if (trimmed) clusters[clusters.length - 1] = trimmed;
    else clusters.pop();
  }
  return clusters;
}

function safeAuthorLabel(value: string, authorId: string): { plain: string; markdown: string } {
  const sanitize = (candidate: string) => sanitizePresentation(candidate, " ").value.replace(/\s+/gu, " ").trim();
  const normalized = sanitize(value) || sanitize(authorId) || "unknown author";
  const plain = truncateUtf16(neutralizeMentions(normalized), 128);
  return { plain, markdown: escapeDiscordMarkdown(plain) };
}

function safeAvatarUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const normalized = url.toString();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
      && normalized.length <= 2048
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function safeTimestamp(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => {
    if (typeof value !== "string") return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });
}

function matchedField(serialized: string): { name: string; value: string } {
  let reasons: unknown = [];
  try { reasons = JSON.parse(serialized); } catch { reasons = ["unreadable stored reasons"]; }
  const values = Array.isArray(reasons) ? reasons : ["unreadable stored reasons"];
  const plain = values.length
    ? sanitizePresentation(values.map(String).join(", "), " ").value.replace(/\s+/gu, " ").trim()
    : "all-message mode";
  return { name: "Matched", value: escapeDiscordMarkdown(truncateUtf16(plain || "all-message mode", 480)) };
}

function quote(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

function evidenceFiles(evidence: StoredEvidence, attachContent: boolean): EvidenceFile[] {
  const { message, attachments } = evidence;
  const attachmentFiles: EvidenceFile[] = attachments.map((attachment) => ({
    attachment: attachment.bytes,
    name: safeFilename(attachment.filename, `attachment-${attachment.attachment_id}`),
    description: `Preserved attachment ${attachment.attachment_id}`,
  }));
  if (!attachContent) return attachmentFiles;
  const name = fullContentFilename(message.message_id);
  return [{ attachment: Buffer.from(message.content, "utf8"), name, description: "Full deleted message content" }, ...attachmentFiles];
}

function legacyV02AttachesContent(evidence: StoredEvidence): boolean {
  const { message } = evidence;
  let reasons: unknown = [];
  try { reasons = JSON.parse(message.matched_reasons); } catch { reasons = ["unreadable stored reasons"]; }
  const values = Array.isArray(reasons) ? reasons : ["unreadable stored reasons"];
  const timestamp = Math.floor(new Date(message.created_at).getTime() / 1000);
  const header = [
    "**Deleted message captured**",
    `Author: ${escapeDiscordMarkdown(message.author_tag)} (<@${message.author_id}> \`${message.author_id}\`)`,
    `Channel: <#${message.channel_id}>`,
    `Posted: <t:${timestamp}:F>`,
    values.length ? `Matched: ${values.map((reason) => escapeDiscordMarkdown(String(reason))).join(", ")}` : "Matched: all-message mode",
  ].join("\n");
  const inline = `${header}\nContent:\n${message.content ? escapeDiscordMarkdown(message.content) : "*(no text content)*"}`;
  return inline.length > 2000;
}

function firstEmbedDescription(evidence: StoredEvidence, deletionLine: string): { description: string; attachContent: boolean } {
  const sanitizedContent = sanitizePresentation(evidence.message.content, "�", true);
  const displayContent = sanitizedContent.value;
  const hasVisibleContent = evidence.message.content.trim().length > 0;
  const escapedContent = hasVisibleContent ? escapeDiscordMarkdown(displayContent) : "*(no text content)*";
  const description = `${deletionLine}\n\n${quote(escapedContent)}`;
  if (description.length <= 4096) {
    return { description, attachContent: sanitizedContent.changed || (!hasVisibleContent && evidence.message.content.length > 0) };
  }
  const name = fullContentFilename(evidence.message.message_id);
  return {
    description: `${deletionLine}\n\n> Full deleted message text is attached as **${escapeInlineFilenameMarkdown(name)}**.`,
    attachContent: true,
  };
}

export function buildEvidencePayloads(evidence: StoredEvidence, batchPlanVersion = 2): EvidencePayload[] {
  const authorLabel = safeAuthorLabel(evidence.message.author_tag, evidence.message.author_id);
  const authorIdentity = /^\d{17,20}$/.test(evidence.message.author_id)
    ? `[${authorLabel.markdown}](https://discord.com/users/${evidence.message.author_id})`
    : authorLabel.markdown;
  const channelIdentity = /^\d{17,20}$/.test(evidence.message.channel_id)
    ? `<#${evidence.message.channel_id}>`
    : "an unknown channel";
  const deletionLine = `Message sent by ${authorIdentity} deleted in ${channelIdentity}`;
  const first = firstEmbedDescription(evidence, deletionLine);
  let files = evidenceFiles(evidence, first.attachContent);
  // A pending exact-content attachment that the legacy (v0.2) plan never accounted for.
  // It must land in its own trailing batch rather than being folded into the legacy
  // file-count chunking, so that a change in the required-attachment rule can never
  // let delivery_batch_index reach or exceed payloads.length while it is still unsent
  // (which would cause deliverEvidence to skip sending it and delete the evidence).
  let pendingLegacyContentFile: EvidenceFile | undefined;
  if (batchPlanVersion === 1) {
    const legacyAttachedContent = legacyV02AttachesContent(evidence);
    files = evidenceFiles(evidence, legacyAttachedContent);
    if (first.attachContent && !legacyAttachedContent) {
      pendingLegacyContentFile = evidenceFiles(evidence, true)[0];
    }
  }
  const avatarUrl = safeAvatarUrl(evidence.message.author_avatar_url);
  const matchContext = matchedField(evidence.message.matched_reasons);
  const footerMessageId = truncateUtf16(sanitizePresentation(evidence.message.message_id, "�").value, 244);
  const timestamp = safeTimestamp(evidence.message.deleted_at, evidence.message.created_at);
  const makeEmbed = (description: string) => ({
    color: 0xed4245,
    author: {
      name: authorLabel.plain,
      ...(avatarUrl ? { icon_url: avatarUrl } : {}),
    },
    description,
    fields: [matchContext],
    footer: { text: `Message ID: ${footerMessageId}` },
    ...(timestamp ? { timestamp } : {}),
  });
  const batches: EvidencePayload[] = [];
  for (let offset = 0; offset < Math.max(1, files.length); offset += 10) {
    batches.push({
      content: "",
      allowedMentions: { parse: [], repliedUser: false },
      files: files.slice(offset, offset + 10),
      embeds: [makeEmbed(offset === 0 ? first.description : `${deletionLine}\n\n> Preserved attachments continued.`)],
    });
  }
  if (pendingLegacyContentFile) {
    batches.push({
      content: "",
      allowedMentions: { parse: [], repliedUser: false },
      files: [pendingLegacyContentFile],
      embeds: [makeEmbed(batches.length === 0 ? first.description : `${deletionLine}\n\n> Preserved attachments continued.`)],
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
    const payloads = buildEvidencePayloads(evidence, evidence.message.delivery_batch_plan_version ?? 1);
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
