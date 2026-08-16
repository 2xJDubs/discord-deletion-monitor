import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup } from "./backup.js";

describe("backup CLI helper", () => {
  it("creates a timestamped database in the requested destination directory and closes the source", async () => {
    const backup = vi.fn(async () => undefined);
    const close = vi.fn();
    const destination = await runBackup({
      databasePath: "/data/messages.db",
      destinationDirectory: "/backups",
      now: new Date("2026-08-15T03:15:16.123Z"),
      sourceStat: () => ({ isFile: () => true }),
      openStore: () => ({ backup, close }),
    });
    expect(destination).toBe("/backups/discord-deletion-monitor-20260815T031516123Z.db");
    expect(backup).toHaveBeenCalledWith(destination);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the source database when backup fails", async () => {
    const close = vi.fn();
    await expect(runBackup({
      databasePath: "/data/messages.db", destinationDirectory: "/backups", now: new Date(),
      sourceStat: () => ({ isFile: () => true }),
      openStore: () => ({ backup: async () => { throw new Error("disk full"); }, close }),
    })).rejects.toThrow("disk full");
    expect(close).toHaveBeenCalledTimes(1);
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
});
