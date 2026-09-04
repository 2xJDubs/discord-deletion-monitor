import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup } from "./backup.js";
import { MessageStore } from "./database.js";

describe("backup CLI helper", () => {
  it("creates a timestamped database in the requested destination directory and closes the source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-mocked-success-"));
    const backups = join(directory, "backups");
    const backup = vi.fn(async () => undefined);
    const close = vi.fn();
    try {
      const destination = await runBackup({
        databasePath: "/data/messages.db",
        destinationDirectory: backups,
        now: new Date("2026-08-15T03:15:16.123Z"),
        sourceStat: () => ({ isFile: () => true }),
        openStore: () => ({ backup, close }),
        validateBackup: () => undefined,
        publishBackup: () => undefined,
      });
      expect(destination).toBe(join(backups, "discord-deletion-monitor-20260815T031516123Z.db"));
      expect(backup).toHaveBeenCalledWith(expect.stringMatching(/\/backups\/\.discord-deletion-monitor-20260815T031516123Z\.db\.tmp-/));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes the source database when backup fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-mocked-failure-"));
    const backups = join(directory, "backups");
    const close = vi.fn();
    try {
      await expect(runBackup({
        databasePath: "/data/messages.db", destinationDirectory: backups, now: new Date(),
        sourceStat: () => ({ isFile: () => true }),
        openStore: () => ({ backup: async () => { throw new Error("disk full"); }, close }),
      })).rejects.toThrow("disk full");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing destination directory", async () => {
    await expect(runBackup({ databasePath: "messages.db", destinationDirectory: "", now: new Date() })).rejects.toThrow(/destination/i);
  });

  it("rejects a blank source database path", async () => {
    await expect(runBackup({ databasePath: "   ", destinationDirectory: "/backups", now: new Date() })).rejects.toThrow(/database path/i);
  });

  it("rejects a missing source before opening a store that could create it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-source-"));
    const source = join(directory, "missing.db");
    const openStore = vi.fn(() => ({ backup: async () => undefined, close: vi.fn() }));
    try {
      await expect(runBackup({ databasePath: source, destinationDirectory: directory, now: new Date(), openStore })).rejects.toThrow(/regular file/i);
      expect(openStore).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a non-regular symlink source before opening the store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-source-"));
    const target = join(directory, "target.db");
    const source = join(directory, "source.db");
    writeFileSync(target, "database");
    symlinkSync(target, source);
    const openStore = vi.fn(() => ({ backup: async () => undefined, close: vi.fn() }));
    try {
      await expect(runBackup({ databasePath: source, destinationDirectory: directory, now: new Date(), openStore })).rejects.toThrow(/regular file/i);
      expect(openStore).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens the source without migration and rejects a newer schema without mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-source-"));
    const source = join(directory, "source.db");
    const db = new Database(source);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged'); PRAGMA user_version = 999");
    db.close();
    const before = readFileSync(source);
    try {
      await expect(runBackup({ databasePath: source, destinationDirectory: directory, now: new Date() })).rejects.toThrow(/newer|unsupported/i);
      expect(readFileSync(source).equals(before)).toBe(true);
      expect(readdirSync(directory)).toEqual(["source.db"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates a backup before atomically publishing it and leaves no temp file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-publish-"));
    const source = join(directory, "source.db");
    const backups = join(directory, "backups");
    const store = new MessageStore(source, 336);
    store.close();
    try {
      const destination = await runBackup({ databasePath: source, destinationDirectory: backups, now: new Date("2026-08-15T03:15:16.123Z") });
      expect(readdirSync(backups)).toEqual(["discord-deletion-monitor-20260815T031516123Z.db"]);
      const backup = new Database(destination, { readonly: true });
      expect(backup.pragma("quick_check", { simple: true })).toBe("ok");
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(backup.pragma("foreign_key_check")).toEqual([]);
      backup.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cleans the unique temp file when backup integrity validation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-invalid-"));
    const source = join(directory, "source.db");
    writeFileSync(source, "source-placeholder");
    try {
      await expect(runBackup({
        databasePath: source, destinationDirectory: directory, now: new Date("2026-08-15T03:15:16.123Z"),
        openStore: () => ({ backup: async (path) => { writeFileSync(path, "corrupt"); }, close: vi.fn() }),
      })).rejects.toThrow();
      expect(readdirSync(directory)).toEqual(["source.db"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
