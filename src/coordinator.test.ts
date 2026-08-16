import { describe, expect, it, vi } from "vitest";
import { CaptureCoordinator } from "./coordinator.js";
import type { MessageSnapshot } from "./capture.js";

function snapshot(id: string): MessageSnapshot {
  return { messageId: id, guildId: "g", channelId: "c", authorId: "u", authorTag: "user", content: `text-${id}`,
    createdAt: new Date("2026-01-01T00:00:00Z"), reasons: [], attachments: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CaptureCoordinator", () => {
  it("waits for in-flight capture before deletion delivery", async () => {
    const gate = deferred<[]>();
    const save = vi.fn();
    const coordinator = new CaptureCoordinator({ save }, async () => gate.promise, { concurrency: 1, maxQueued: 1 });
    const capture = coordinator.capture(snapshot("m1"));
    const deliver = vi.fn();
    const deletion = coordinator.afterCapture("m1", deliver);
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
    gate.resolve([]);
    await Promise.all([capture, deletion]);
    expect(save).toHaveBeenCalledBefore(deliver);
  });

  it("bounds global capture concurrency and saves text on queue overflow", async () => {
    const gates = [deferred<[]>(), deferred<[]>()];
    let active = 0;
    let peak = 0;
    const download = vi.fn(async () => {
      const gate = gates[download.mock.calls.length - 1];
      active += 1; peak = Math.max(peak, active);
      const value = await gate.promise;
      active -= 1;
      return value;
    });
    const save = vi.fn();
    const coordinator = new CaptureCoordinator({ save }, download, { concurrency: 1, maxQueued: 1 });
    const tasks = [coordinator.capture(snapshot("m1")), coordinator.capture(snapshot("m2")), coordinator.capture(snapshot("m3"))];
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ message_id: "m3", content: "text-m3" }), []);
    gates[0].resolve([]); await tasks[0];
    gates[1].resolve([]); await Promise.all(tasks);
    expect(peak).toBe(1);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("stops accepting work and aborts active attachment downloads", async () => {
    const save = vi.fn();
    let signal: AbortSignal | undefined;
    const coordinator = new CaptureCoordinator({ save }, async (_id, _items, abortSignal) => {
      signal = abortSignal;
      await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    }, { concurrency: 1, maxQueued: 1 });
    const active = coordinator.capture(snapshot("m1"));
    await Promise.resolve();
    coordinator.stop();
    expect(signal?.aborted).toBe(true);
    await active;
    await expect(coordinator.capture(snapshot("m2"))).resolves.toBe(false);
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ message_id: "m2" }), expect.anything());
  });

  it("rejects failed active and queued captures without leaving queued promises stuck", async () => {
    const first = deferred<[]>();
    const failure = new Error("download failed");
    const download = vi.fn()
      .mockImplementationOnce(async () => first.promise)
      .mockRejectedValueOnce(failure);
    const coordinator = new CaptureCoordinator({ save: vi.fn() }, download, { concurrency: 1, maxQueued: 1 });
    const active = coordinator.capture(snapshot("m1"));
    const queued = coordinator.capture(snapshot("m2"));
    first.resolve([]);
    await expect(active).resolves.toBe(true);
    await expect(queued).rejects.toThrow("download failed");
    await expect(coordinator.afterCapture("m2", () => "continued")).resolves.toBe("continued");
  });

  it("propagates text-only store failures without an unhandled cleanup rejection", async () => {
    const gate = deferred<[]>();
    const failure = new Error("database write failed");
    const save = vi.fn((item: { message_id: string }) => { if (item.message_id === "m2") throw failure; });
    const coordinator = new CaptureCoordinator({ save }, async () => gate.promise, { concurrency: 1, maxQueued: 0 });
    const active = coordinator.capture(snapshot("m1"));
    await expect(coordinator.capture(snapshot("m2"))).rejects.toThrow("database write failed");
    gate.resolve([]);
    await active;
  });
});
