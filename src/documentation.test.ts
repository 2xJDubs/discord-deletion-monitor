import { readFileSync } from "node:fs";
import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("self-service documentation", () => {
  it("documents the complete Discord application and first-server path", () => {
    const readme = read("../README.md");
    for (const item of [
      "Installation Contexts", "Guild Install", "applications.commands", "Message Content Intent",
      "Public Bot", "Requires OAuth2 Code Grant", "Embed Links", "Do **not** select **Administrator**",
      "Local development", "Production self-hosting", "global application command", "First-server walkthrough",
      "/monitor review-channel", "/monitor setup", "/monitor diagnostics", "repository is private",
    ]) expect(readme).toContain(item);
  });

  it("keeps the documented invite permission integer least-privileged", () => {
    const documented = read("../README.md").match(/permissions=(\d+)/)?.[1];
    const leastPrivilege = PermissionFlagsBits.ViewChannel
      | PermissionFlagsBits.ReadMessageHistory
      | PermissionFlagsBits.SendMessages
      | PermissionFlagsBits.EmbedLinks
      | PermissionFlagsBits.AttachFiles;
    expect(documented).toBe(leastPrivilege.toString());
    expect(leastPrivilege & PermissionFlagsBits.Administrator).toBe(0n);
  });

  it("documents capture-time avatar data in the privacy inventory", () => {
    const privacy = read("../docs/data-retention.md");
    expect(privacy).toContain("Discord CDN avatar URL at capture time");
    expect(privacy).toContain("deletion timestamps");
  });

  it("documents a foreign-key check that fails on sqlite errors and violations", () => {
    const deployment = read("../deploy/README.md");
    const safeChecks = deployment.match(/output=\$\(sqlite3 "\$1" "PRAGMA foreign_key_check;"\) && test -z "\$output"/g) ?? [];
    expect(safeChecks).toHaveLength(2);
    expect(deployment).not.toContain("'PRAGMA foreign_key_check;' | { ! grep -q .; }");
  });

  it("consolidates production readiness, persistence, backup, restart, timer, and log checks", () => {
    const deployment = read("../deploy/README.md");
    for (const item of [
      "Consolidated post-install verification", "client_ready", "applications.commands", "/monitor settings",
      "systemctl restart", "Controlled evidence test", "Backup integrity", "PRAGMA quick_check",
      "PRAGMA foreign_key_check", "list-timers", "journal",
    ]) expect(deployment).toContain(item);
  });
});
