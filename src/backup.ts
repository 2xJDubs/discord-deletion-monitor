import "dotenv/config";
import { runBackup } from "./backup-core.js";
import { type LogLevel } from "./config.js";
import { createJsonLogger } from "./runtime.js";

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

main().catch((error: unknown) => {
  const log = createJsonLogger("info", (line) => console.error(line));
  log("backup_failed", { error: error instanceof Error ? error.message : String(error) }, "error");
  process.exitCode = 1;
});
