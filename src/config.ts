export type LogLevel = "debug" | "info" | "warn" | "error";
export type AppConfig = {
  token: string;
  databasePath: string;
  retentionHours: number;
  attachmentMaxFileBytes: number;
  attachmentMaxTotalBytes: number;
  attachmentDownloadTimeoutMs: number;
  databaseBusyTimeoutMs: number;
  storedAttachmentMaxBytes: number;
  captureConcurrency: number;
  captureQueueMax: number;
  deliveryRetryIntervalMs: number;
  deliveryRetryBatchSize: number;
  shutdownDrainTimeoutMs: number;
  logLevel: LogLevel;
};

export function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is required");
  const logLevel = env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  const attachmentMaxFileBytes = positiveInteger(env, "ATTACHMENT_MAX_FILE_BYTES", 8 * 1024 * 1024, 64 * 1024 * 1024);
  const attachmentMaxTotalBytes = positiveInteger(env, "ATTACHMENT_MAX_TOTAL_BYTES", 24 * 1024 * 1024, 64 * 1024 * 1024);
  if (attachmentMaxTotalBytes < attachmentMaxFileBytes) throw new Error("ATTACHMENT_MAX_TOTAL_BYTES must be at least ATTACHMENT_MAX_FILE_BYTES");
  const captureConcurrency = positiveInteger(env, "CAPTURE_CONCURRENCY", 2, 16);
  if (attachmentMaxTotalBytes * captureConcurrency > 128 * 1024 * 1024) {
    throw new Error("CAPTURE_CONCURRENCY and ATTACHMENT_MAX_TOTAL_BYTES exceed the 128 MiB capture memory budget");
  }
  return {
    token,
    databasePath: (() => {
      if (env.DATABASE_PATH === undefined) return "./data/messages.db";
      const path = env.DATABASE_PATH.trim();
      if (!path) throw new Error("DATABASE_PATH must not be empty");
      return path;
    })(),
    retentionHours: positiveInteger(env, "RETENTION_HOURS", 336, 2160),
    attachmentMaxFileBytes,
    attachmentMaxTotalBytes,
    attachmentDownloadTimeoutMs: positiveInteger(env, "ATTACHMENT_DOWNLOAD_TIMEOUT_MS", 10_000, 120_000),
    databaseBusyTimeoutMs: positiveInteger(env, "DATABASE_BUSY_TIMEOUT_MS", 5_000, 60_000),
    storedAttachmentMaxBytes: positiveInteger(env, "STORED_ATTACHMENT_MAX_BYTES", 1024 * 1024 * 1024, 10 * 1024 ** 3),
    captureConcurrency,
    captureQueueMax: positiveInteger(env, "CAPTURE_QUEUE_MAX", 100, 10_000),
    deliveryRetryIntervalMs: positiveInteger(env, "DELIVERY_RETRY_INTERVAL_MS", 30_000, 120_000),
    deliveryRetryBatchSize: positiveInteger(env, "DELIVERY_RETRY_BATCH_SIZE", 50, 1_000),
    shutdownDrainTimeoutMs: positiveInteger(env, "SHUTDOWN_DRAIN_TIMEOUT_MS", 30_000, 120_000),
    logLevel: logLevel as LogLevel,
  };
}
