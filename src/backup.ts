import "dotenv/config";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { lstatSync } from "node:fs";
import { MessageStore } from "./database.js";
import { positiveInteger, type LogLevel } from "./config.js";
import { createJsonLogger } from "./runtime.js";

type BackupStore = { backup(destination: string): Promise<void>; close(): unknown };
type BackupOptions = {
  databasePath: string;
  destinationDirectory: string;
  now: Date;
  openStore?: (databasePath: string) => BackupStore;
  sourceStat?: (databasePath: string) => { isFile(): boolean };
};

export async function runBackup(options: BackupOptions): Promise<string> {
  const databasePath = options.databasePath.trim();
  const destinationDirectory = options.destinationDirectory.trim();
  if (!databasePath) throw new Error("Backup database path is required");
  if (!destinationDirectory) throw new Error("Backup destination directory is required");
  let isRegularFile = false;
  try { isRegularFile = (options.sourceStat ?? lstatSync)(databasePath).isFile(); } catch { /* normalized below */ }
  if (!isRegularFile) throw new Error("Backup source database must exist and be a regular file");
  const stamp = options.now.toISOString().replace(/[-:.]/g, "");
  const destination = join(destinationDirectory, `discord-deletion-monitor-${stamp}.db`);
  const store = (options.openStore ?? ((path) => new MessageStore(
    path,
    positiveInteger(process.env, "RETENTION_HOURS", 336, 2160),
    { busyTimeoutMs: positiveInteger(process.env, "DATABASE_BUSY_TIMEOUT_MS", 5_000) },
  )))(databasePath);
  try {
    await store.backup(destination);
    return destination;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  const log = createJsonLogger(logLevel);
  const destination = await runBackup({
    databasePath: process.env.DATABASE_PATH ?? "./data/messages.db",
    destinationDirectory: process.argv[2] ?? "",
    now: new Date(),
  });
  log("backup_complete", { destination });
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const log = createJsonLogger("info", (line) => console.error(line));
    log("backup_failed", { error: error instanceof Error ? error.message : String(error) }, "error");
    process.exitCode = 1;
  });
}
