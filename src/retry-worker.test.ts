import { describe, expect, it, vi } from "vitest";
import { createDeliveryRetryWorker } from "./retry-worker.js";

describe("delivery retry worker", () => {
  it("retries a bounded pending batch immediately after startup", async () => {
    const pending = [
      { message_id: "m1", guild_id: "g1" },
      { message_id: "m2", guild_id: "g2" },
    ];
    const listDuePending = vi.fn(() => pending);
    const deliver = vi.fn(async () => true);
    const worker = createDeliveryRetryWorker({
      listDuePending,
      deliver,
      intervalMs: 30_000,
      batchSize: 2,
      runWork: async (work) => { await work(); return true; },
      log: vi.fn(),
    });

    await worker.runNow();

    expect(listDuePending).toHaveBeenCalledWith(expect.any(Date), 2);
    expect(deliver.mock.calls).toEqual([["g1", "m1"], ["g2", "m2"]]);
    worker.stop();
  });

  it("suppresses overlapping runs and reports rejected work", async () => {
    let release!: () => void;
    const deliver = vi.fn(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const log = vi.fn();
    const worker = createDeliveryRetryWorker({
      listDuePending: () => [{ message_id: "m1", guild_id: "g1" }],
      deliver,
      intervalMs: 30_000,
      batchSize: 5,
      runWork: async (work) => { await work(); return true; },
      log,
    });

    const first = worker.runNow();
    await Promise.resolve();
    await worker.runNow();
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await first;

    const rejected = createDeliveryRetryWorker({
      listDuePending: () => { throw new Error("db closed"); },
      deliver,
      intervalMs: 30_000,
      batchSize: 5,
      runWork: async (work) => { await work(); return true; },
      log,
    });
    await expect(rejected.runNow()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("delivery_retry_failed", expect.objectContaining({ error: "db closed" }), "error");
    worker.stop();
    rejected.stop();
  });

  it("starts immediately and stops its interval", async () => {
    vi.useFakeTimers();
    const listDuePending = vi.fn(() => []);
    const worker = createDeliveryRetryWorker({
      listDuePending,
      deliver: vi.fn(async () => true),
      intervalMs: 1000,
      batchSize: 5,
      runWork: async (work) => { await work(); return true; },
      log: vi.fn(),
    });

    worker.start();
    await vi.runAllTicks();
    await Promise.resolve();
    expect(listDuePending).toHaveBeenCalledTimes(1);
    worker.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(listDuePending).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
