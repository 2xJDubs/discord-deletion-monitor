import { describe, expect, it, vi } from "vitest";
import { downloadAttachments } from "./attachments.js";

const items = [
  { id: "a1", url: "https://cdn.test/a.txt", name: "a.txt", contentType: "text/plain", size: 3 },
  { id: "a2", url: "https://cdn.test/b.bin", name: "b.bin", contentType: null, size: 4 },
];

describe("downloadAttachments", () => {
  it("downloads bytes and maps durable metadata", async () => {
    const fetcher = vi.fn(async (url: string) => new Response(url.endsWith("a.txt") ? "abc" : "wxyz"));
    const result = await downloadAttachments("m1", items, { perFileBytes: 10, totalBytes: 10, timeoutMs: 1000 }, fetcher, vi.fn());
    expect(result.map((entry) => ({ id: entry.attachment_id, name: entry.filename, bytes: entry.bytes.toString() })))
      .toEqual([{ id: "a1", name: "a.txt", bytes: "abc" }, { id: "a2", name: "b.bin", bytes: "wxyz" }]);
  });

  it("skips declared files over the per-file limit without fetching", async () => {
    const fetcher = vi.fn();
    const log = vi.fn();
    expect(await downloadAttachments("m1", [items[1]], { perFileBytes: 3, totalBytes: 10, timeoutMs: 1000 }, fetcher, log)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("attachment_skipped", expect.objectContaining({ reason: "per_file_limit" }));
  });

  it("enforces the actual response size and total byte limit", async () => {
    const fetcher = vi.fn(async () => new Response("12345"));
    const log = vi.fn();
    const result = await downloadAttachments("m1", items.map((item) => ({ ...item, size: 1 })), { perFileBytes: 5, totalBytes: 6, timeoutMs: 1000 }, fetcher, log);
    expect(result).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("attachment_skipped", expect.objectContaining({ reason: "total_limit" }));
  });

  it("streams chunks into one bounded allocation without concatenating duplicate buffers", async () => {
    const concat = vi.spyOn(Buffer, "concat");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([97, 98]));
        controller.enqueue(new Uint8Array([99, 100]));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => new Response(stream));
    const result = await downloadAttachments("m1", [{ ...items[0], size: 4 }], { perFileBytes: 4, totalBytes: 4, timeoutMs: 1000 }, fetcher, vi.fn());
    expect(result[0].bytes.toString()).toBe("abcd");
    expect(result[0].bytes.buffer.byteLength).toBe(4);
    expect(concat).not.toHaveBeenCalled();
    concat.mockRestore();
  });

  it("logs fetch failures and returns other attachments instead of throwing", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("a.txt")) throw new Error("network down");
      return new Response("wxyz");
    });
    const log = vi.fn();
    const result = await downloadAttachments("m1", items, { perFileBytes: 10, totalBytes: 10, timeoutMs: 1000 }, fetcher, log);
    expect(result.map((entry) => entry.attachment_id)).toEqual(["a2"]);
    expect(log).toHaveBeenCalledWith("attachment_download_failed", expect.objectContaining({ attachmentId: "a1", error: "network down" }));
  });

  it("cancels a response stream as soon as its bytes exceed the per-file limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
      },
      cancel() { cancelled = true; },
    });
    const fetcher = vi.fn(async () => new Response(body));
    const result = await downloadAttachments("m1", [{ ...items[0], size: 1 }], { perFileBytes: 5, totalBytes: 10, timeoutMs: 1000 }, fetcher, vi.fn());
    expect(result).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it("aborts downloads after the configured timeout", async () => {
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const log = vi.fn();
    const result = await downloadAttachments("m1", [items[0]], { perFileBytes: 10, totalBytes: 10, timeoutMs: 5 }, fetcher, log);
    expect(result).toEqual([]);
    expect(log).toHaveBeenCalledWith("attachment_download_failed", expect.objectContaining({ attachmentId: "a1" }));
  });

  it("aborts downloads when the service shutdown signal fires", async () => {
    const controller = new AbortController();
    let downloadSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      downloadSignal = init?.signal;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = downloadAttachments("m1", [items[0]], { perFileBytes: 10, totalBytes: 10, timeoutMs: 1000, signal: controller.signal }, fetcher, vi.fn());
    controller.abort();
    expect(downloadSignal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual([]);
  });
});
