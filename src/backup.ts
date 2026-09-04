import "dotenv/config";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { openBackupSource } from "./database.js";
import { positiveInteger, type LogLevel } from "./config.js";
import { createJsonLogger } from "./runtime.js";

type BackupStore = { backup(destination: string): Promise<void>; close(): unknown };
type BackupOptions = {
  databasePath: string;
  destinationDirectory: string;
  now: Date;
  openStore?: (databasePath: string) => BackupStore;
  sourceStat?: (databasePath: string) => { isFile(): boolean };
  validateBackup?: (databasePath: string) => void;
  publishBackup?: (temporaryPath: string, destination: string) => void;
};

function validateBackup(databasePath: string): void {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Backup quick_check failed");
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Backup integrity_check failed");
    const foreignKeyFailures = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyFailures.length > 0) throw new Error(`Backup foreign_key_check failed (${foreignKeyFailures.length} rows)`);
  } finally {
    db.close();
  }
}

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
  if (existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  mkdirSync(destinationDirectory, { recursive: true });
  const temporary = join(destinationDirectory, `.${`discord-deletion-monitor-${stamp}.db`}.tmp-${randomUUID()}`);
  const store = (options.openStore ?? ((path) => openBackupSource(
    path,
    positiveInteger(process.env, "DATABASE_BUSY_TIMEOUT_MS", 5_000),
  )))(databasePath);
  try {
    await store.backup(temporary);
    (options.validateBackup ?? validateBackup)(temporary);
    (options.publishBackup ?? renameSync)(temporary, destination);
    return destination;
  } finally {
    store.close();
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });
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
