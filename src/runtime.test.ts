import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RETENTION_PURGE_INTERVAL_MS, loadConfig } from "./config.js";
import { ActiveWorkTracker, createJsonLogger, installGracefulShutdown, safeAsyncHandler } from "./runtime.js";

describe("loadConfig", () => {
  it("purges at minute granularity", () => {
    expect(RETENTION_PURGE_INTERVAL_MS).toBe(60_000);
  });
  it("trims DATABASE_PATH and rejects whitespace-only paths", () => {
    expect(loadConfig({ DISCORD_TOKEN: "token", DATABASE_PATH: "  /tmp/messages.db  " }).databasePath).toBe("/tmp/messages.db");
    expect(() => loadConfig({ DISCORD_TOKEN: "token", DATABASE_PATH: "   " })).toThrow(/DATABASE_PATH/);
  });

  it.each([
    ["RETENTION_MINUTES", "129601"],
    ["ATTACHMENT_MAX_FILE_BYTES", String(64 * 1024 * 1024 + 1)],
    ["ATTACHMENT_MAX_TOTAL_BYTES", String(64 * 1024 * 1024 + 1)],
    ["ATTACHMENT_DOWNLOAD_TIMEOUT_MS", "120001"],
    ["DATABASE_BUSY_TIMEOUT_MS", "60001"],
  ])("rejects impractical or timer-unsafe %s", (name, value) => {
    expect(() => loadConfig({ DISCORD_TOKEN: "token", [name]: value })).toThrow(new RegExp(name));
  });
  it("accepts each operational numeric maximum", () => {
    expect(loadConfig({ DISCORD_TOKEN: "token", ATTACHMENT_MAX_FILE_BYTES: String(64 * 1024 * 1024),
      ATTACHMENT_MAX_TOTAL_BYTES: String(64 * 1024 * 1024), ATTACHMENT_DOWNLOAD_TIMEOUT_MS: "120000",
      DATABASE_BUSY_TIMEOUT_MS: "60000" })).toMatchObject({ attachmentMaxFileBytes: 64 * 1024 * 1024,
      attachmentMaxTotalBytes: 64 * 1024 * 1024, attachmentDownloadTimeoutMs: 120000, databaseBusyTimeoutMs: 60000 });
  });
  it("parses supported numeric environment configuration", () => {
    expect(loadConfig({
      DISCORD_TOKEN: "token", RETENTION_MINUTES: "90", ATTACHMENT_MAX_FILE_BYTES: "100",
      ATTACHMENT_MAX_TOTAL_BYTES: "250", ATTACHMENT_DOWNLOAD_TIMEOUT_MS: "3000",
      DATABASE_BUSY_TIMEOUT_MS: "4000", LOG_LEVEL: "warn",
    })).toMatchObject({ retentionMinutes: 90, attachmentMaxFileBytes: 100, attachmentMaxTotalBytes: 250,
      attachmentDownloadTimeoutMs: 3000, databaseBusyTimeoutMs: 4000, logLevel: "warn" });
  });

  it("defaults retention to 60 minutes and converts the legacy hours setting", () => {
    expect(loadConfig({ DISCORD_TOKEN: "token" }).retentionMinutes).toBe(60);
    expect(loadConfig({ DISCORD_TOKEN: "token", RETENTION_HOURS: "24" }).retentionMinutes).toBe(1440);
    expect(loadConfig({ DISCORD_TOKEN: "token", RETENTION_MINUTES: "90", RETENTION_HOURS: "24" }).retentionMinutes).toBe(90);
  });

  it("parses and bounds queue, storage, retry, and shutdown settings", () => {
    const env = { DISCORD_TOKEN: "token", STORED_ATTACHMENT_MAX_BYTES: "1000", CAPTURE_CONCURRENCY: "3",
      CAPTURE_QUEUE_MAX: "20", DELIVERY_RETRY_INTERVAL_MS: "4000", DELIVERY_RETRY_BATCH_SIZE: "5", SHUTDOWN_DRAIN_TIMEOUT_MS: "6000" };
    expect(loadConfig(env)).toMatchObject({ storedAttachmentMaxBytes: 1000, captureConcurrency: 3, captureQueueMax: 20,
      deliveryRetryIntervalMs: 4000, deliveryRetryBatchSize: 5, shutdownDrainTimeoutMs: 6000 });
    for (const [name, value] of [["STORED_ATTACHMENT_MAX_BYTES", String(10 * 1024 ** 3 + 1)], ["CAPTURE_CONCURRENCY", "17"],
      ["CAPTURE_QUEUE_MAX", "10001"], ["DELIVERY_RETRY_INTERVAL_MS", "120001"], ["DELIVERY_RETRY_BATCH_SIZE", "1001"],
      ["SHUTDOWN_DRAIN_TIMEOUT_MS", "120001"]]) {
      expect(() => loadConfig({ DISCORD_TOKEN: "token", [name]: value })).toThrow(new RegExp(name));
    }
  });

  it.each(["NaN", "0", "-1", "1.5", "Infinity", "10oops"])("rejects invalid numeric values: %s", (value) => {
    expect(() => loadConfig({ DISCORD_TOKEN: "token", ATTACHMENT_MAX_FILE_BYTES: value })).toThrow(/ATTACHMENT_MAX_FILE_BYTES/);
  });

  it("rejects a total attachment limit below the per-file limit", () => {
    expect(() => loadConfig({ DISCORD_TOKEN: "token", ATTACHMENT_MAX_FILE_BYTES: "20", ATTACHMENT_MAX_TOTAL_BYTES: "10" })).toThrow(/ATTACHMENT_MAX_TOTAL_BYTES/);
  });

  it("rejects an aggregate concurrent attachment budget above 128 MiB", () => {
    expect(() => loadConfig({
      DISCORD_TOKEN: "token",
      ATTACHMENT_MAX_TOTAL_BYTES: String(64 * 1024 * 1024),
      CAPTURE_CONCURRENCY: "3",
    })).toThrow(/CAPTURE_CONCURRENCY.*memory budget/);
  });

  it("rejects missing token and unknown log levels", () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/);
    expect(() => loadConfig({ DISCORD_TOKEN: "token", LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });
});

describe("structured runtime helpers", () => {
  it("stops accepting handlers and drains active work before Discord and database shutdown", async () => {
    const tracker = new ActiveWorkTracker();
    let finish!: () => void;
    const active = tracker.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    const order: string[] = [];
    const shutdown = installGracefulShutdown({ destroy: () => { order.push("destroy"); } },
      { close: () => { order.push("close"); } }, vi.fn(), new EventEmitter(), () => order.push("stop"),
      { work: tracker, drainTimeoutMs: 1000 });
    const pending = shutdown("SIGTERM");
    await Promise.resolve();
    await expect(tracker.run(async () => undefined)).resolves.toBe(false);
    expect(order).toEqual(["stop"]);
    finish();
    await Promise.all([active, pending]);
    expect(order).toEqual(["stop", "destroy", "close"]);
  });

  it("fails closed without closing the database when active handlers outlive the drain timeout", async () => {
    vi.useFakeTimers();
    const tracker = new ActiveWorkTracker();
    void tracker.run(() => new Promise<void>(() => undefined));
    const close = vi.fn();
    const destroy = vi.fn();
    const log = vi.fn();
    const shutdown = installGracefulShutdown({ destroy }, { close }, log, new EventEmitter(), undefined, { work: tracker, drainTimeoutMs: 50 });
    const pending = shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("shutdown_database_left_open", { activeWorkMayRemain: true }, "error");
    vi.useRealTimers();
  });
  it("does not allow fields to overwrite reserved log keys", () => {
    const write = vi.fn();
    const log = createJsonLogger("debug", write, () => new Date("2026-01-01T00:00:00Z"));
    log("real_event", { timestamp: "fake", level: "debug", event: "fake", detail: 1 }, "warn");
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z", level: "warn", event: "real_event", detail: 1,
    });
  });
  it("writes single-line JSON logs and filters below LOG_LEVEL", () => {
    const write = vi.fn();
    const log = createJsonLogger("warn", write, () => new Date("2026-01-01T00:00:00Z"));
    log("ignored", {}, "info");
    log("delivery_failed", { messageId: "m1", error: new Error("boom") }, "error");
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ timestamp: "2026-01-01T00:00:00.000Z", level: "error", event: "delivery_failed", messageId: "m1", error: "boom" });
  });

  it("adds an outer catch to asynchronous event handlers", async () => {
    const log = vi.fn();
    const wrapped = safeAsyncHandler("message_create", async (_value: string) => { throw new Error("capture failed"); }, log);
    await expect(wrapped("argument")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("event_handler_failed", expect.objectContaining({ event: "message_create", error: "capture failed" }), "error");
  });

  it("destroys the Discord client and closes the store exactly once across both signals", async () => {
    const signals = new EventEmitter();
    const destroy = vi.fn();
    const close = vi.fn();
    const stop = vi.fn();
    const log = vi.fn();
    const shutdown = installGracefulShutdown({ destroy }, { close }, log, signals, stop);
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await shutdown("SIGTERM");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("still closes the database when client destruction fails", async () => {
    const close = vi.fn();
    const log = vi.fn();
    const shutdown = installGracefulShutdown({ destroy: () => { throw new Error("destroy failed"); } }, { close }, log, new EventEmitter());
    await shutdown("SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("shutdown_step_failed", expect.objectContaining({ step: "discord_destroy" }), "error");
  });
});
