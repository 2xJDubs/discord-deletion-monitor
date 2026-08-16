import type { StoredAttachment } from "./database.js";

export type AttachmentSource = {
  id: string;
  url: string;
  name: string;
  contentType: string | null;
  size: number;
};
export type AttachmentLimits = { perFileBytes: number; totalBytes: number; timeoutMs: number; signal?: AbortSignal };
export type EventLogger = (event: string, fields?: Record<string, unknown>) => void;
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBounded(response: Response, maximumBytes: number): Promise<Buffer | undefined> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length <= maximumBytes ? bytes : undefined;
  }
  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafeSlow(maximumBytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, length);
      if (length + value.byteLength > maximumBytes) {
        await reader.cancel("attachment byte limit exceeded");
        return undefined;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function downloadAttachments(
  messageId: string,
  sources: AttachmentSource[],
  limits: AttachmentLimits,
  fetcher: Fetcher = fetch,
  log: EventLogger = () => undefined,
): Promise<StoredAttachment[]> {
  const attachments: StoredAttachment[] = [];
  let total = 0;
  for (const source of sources) {
    if (limits.signal?.aborted) break;
    if (source.size > limits.perFileBytes) {
      log("attachment_skipped", { attachmentId: source.id, reason: "per_file_limit", size: source.size });
      continue;
    }
    if (total + source.size > limits.totalBytes) {
      log("attachment_skipped", { attachmentId: source.id, reason: "total_limit", size: source.size });
      continue;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    limits.signal?.addEventListener("abort", abort, { once: true });
    if (limits.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      const response = await fetcher(source.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remainingTotal = limits.totalBytes - total;
      const maximum = Math.min(limits.perFileBytes, remainingTotal);
      const bytes = await readBounded(response, maximum);
      if (!bytes) {
        const reason = remainingTotal < limits.perFileBytes ? "total_limit" : "per_file_limit";
        log("attachment_skipped", { attachmentId: source.id, reason, limit: maximum });
        continue;
      }
      total += bytes.length;
      attachments.push({
        attachment_id: source.id,
        message_id: messageId,
        filename: source.name || `attachment-${source.id}`,
        content_type: source.contentType,
        size: bytes.length,
        source_url: source.url,
        bytes,
      });
    } catch (error) {
      log("attachment_download_failed", { attachmentId: source.id, error: errorMessage(error) });
    } finally {
      clearTimeout(timeout);
      limits.signal?.removeEventListener("abort", abort);
    }
  }
  return attachments;
}
