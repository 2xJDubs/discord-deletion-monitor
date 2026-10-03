import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MessageStore, type StoredEvidence } from "./database.js";
import { buildEvidencePayload, buildEvidencePayloads, deliverEvidence, type EvidencePayload } from "./evidence.js";

function evidence(content = "hello"): StoredEvidence {
  return {
    message: {
      message_id: "m1", guild_id: "g1", channel_id: "234567890123456789", author_id: "123456789012345678",
      author_tag: "@everyone attacker", content, attachment_urls: "[]",
      matched_reasons: JSON.stringify(["keyword: urgent"]), created_at: "2026-01-01T00:00:00.000Z",
    },
    attachments: [{
      attachment_id: "a1", message_id: "m1", filename: "proof.txt", content_type: "text/plain",
      size: 5, source_url: "https://cdn.test/a1", bytes: Buffer.from("proof"),
    }],
  };
}

describe("buildEvidencePayload", () => {
  it("splits evidence into at most ten files per Discord payload", () => {
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 21 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: `https://cdn.test/${index}`, bytes: Buffer.from("x"),
    }));
    const payloads = buildEvidencePayloads(item);
    expect(payloads.length).toBe(3);
    expect(payloads.every((payload) => payload.files.length <= 10)).toBe(true);
    expect(payloads[0].files[0].name).toBe("0.txt");
    expect(payloads.every((payload) => payload.embeds[0].description.includes("<@123456789012345678> (`123456789012345678`)"))).toBe(true);
  });
  it("formats short evidence under 2,000 characters with mentions disabled and preserved files", () => {
    const payload = buildEvidencePayload(evidence());
    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(payload.content).toBe("");
    expect(payload.embeds[0].description).toContain("> hello");
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload.files).toEqual([expect.objectContaining({ name: "proof.txt", attachment: Buffer.from("proof") })]);
  });

  it("uses a non-pinging guild member mention with a visible user-ID fallback", () => {
    const item = evidence();
    item.message.author_id = "123456789012345678";
    item.message.author_tag = "ordinary user";
    item.message.deleted_at = "2026-01-02T03:04:05.000Z";

    const payload = buildEvidencePayload(item);

    expect(payload.embeds).toEqual([expect.objectContaining({
      color: 0xed4245,
      author: expect.objectContaining({ name: "ordinary user" }),
      description: expect.stringContaining("<@123456789012345678> (`123456789012345678`)"),
      footer: { text: "Message ID: m1" },
      timestamp: "2026-01-02T03:04:05.000Z",
    })]);
    expect(payload.embeds[0].description).not.toContain("https://discord.com/users/");
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it("falls back from malformed or non-ISO legacy deletion timestamps to capture time", () => {
    const item = evidence();
    for (const malformed of ["not-a-timestamp", "1", "2026-02-30T00:00:00.000Z"]) {
      item.message.deleted_at = malformed;
      expect(buildEvidencePayload(item).embeds[0].timestamp).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("uses the capture-time Discord avatar with a legacy-row fallback", () => {
    const item = evidence();
    item.message.author_avatar_url = "https://cdn.discordapp.com/avatars/123/avatar.png";
    expect(buildEvidencePayload(item).embeds[0].author).toEqual({
      name: "@ everyone attacker", icon_url: "https://cdn.discordapp.com/avatars/123/avatar.png",
    });

    item.message.author_avatar_url = null;
    expect(buildEvidencePayload(item).embeds[0].author).toEqual({ name: "@ everyone attacker" });
  });

  it("neutralizes mention syntax in the compact author header", () => {
    const item = evidence();
    item.message.author_tag = "@everyone <@123456789012345678>";
    const payload = buildEvidencePayload(item);

    expect(payload.embeds[0].author.name).toBe("@ everyone < @123456789012345678>");
    expect(payload.embeds[0].author.name).not.toContain("@everyone");
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it("neutralizes mentions without introducing invisible presentation controls", () => {
    const item = evidence("@everyone <@123456789012345678>");
    item.message.author_tag = "@here <@123456789012345678>";
    item.message.matched_reasons = JSON.stringify(["@everyone <@123456789012345678>"]);

    const payload = buildEvidencePayload(item);
    const presentation = JSON.stringify(payload.embeds);

    expect(presentation).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
    expect(payload.embeds[0].author.name).toContain("@ here");
    expect(payload.embeds[0].author.name).toContain("< @123456789012345678>");
    expect(payload.files.some((file) => file.description === "Full deleted message content")).toBe(false);
  });

  it("omits malformed or non-Discord avatar URLs so evidence remains deliverable", () => {
    const item = evidence();
    for (const unsafe of [
      "javascript:alert(1)",
      "https://evil.test/avatar.png",
      "not a URL",
      "https://***@cdn.discordapp.com/avatars/123/avatar.png",
      "https://cdn.discordapp.com:8443/avatars/123/avatar.png",
    ]) {
      item.message.author_avatar_url = unsafe;
      expect(buildEvidencePayload(item).embeds[0].author).toEqual({ name: "@ everyone attacker" });
    }
  });

  it("accepts avatar URLs through 2,048 characters and omits longer URLs", () => {
    const item = evidence();
    const prefix = "https://cdn.discordapp.com/";
    const maximum = prefix + "x".repeat(2048 - prefix.length);

    item.message.author_avatar_url = maximum;
    expect(buildEvidencePayload(item).embeds[0].author.icon_url).toBe(maximum);

    item.message.author_avatar_url = `${maximum}x`;
    expect(buildEvidencePayload(item).embeds[0].author.icon_url).toBeUndefined();
  });

  it("keeps attacker-controlled author labels out of the member mention while preserving a safe compact header", () => {
    const item = evidence();
    item.message.author_id = "123456789012345678";
    item.message.author_tag = "**admin**\n[spoof](https://evil.test)\u202e @everyone";

    const payload = buildEvidencePayload(item);
    const description = payload.embeds[0].description;

    expect(payload.embeds[0].author.name).toBe("**admin** [spoof](https://evil.test) @ everyone");
    expect(description).toContain("<@123456789012345678> (`123456789012345678`)");
    expect(description).not.toContain("evil.test");
    expect(description.split("\n", 1)[0]).not.toMatch(/[\r\u202e]/u);

    item.message.author_tag = "\u0000\u202e\n";
    expect(buildEvidencePayload(item).embeds[0].description)
      .toContain("<@123456789012345678> (`123456789012345678`)");
  });

  it("sanitizes a malformed author-ID fallback when the display name is unavailable", () => {
    const item = evidence();
    item.message.author_tag = "\u0000\u202e\n";
    item.message.author_id = "bad\nid\u202e";

    const embed = buildEvidencePayload(item).embeds[0];

    expect(embed.author.name).toBe("bad id");
    expect(embed.description).toContain("Message sent by bad id deleted in");
    expect(embed.description.split("\n", 1)[0]).not.toMatch(/[\r\u202e]/u);
  });

  it("does not turn malformed legacy author IDs into spoofable profile links", () => {
    const item = evidence();
    item.message.author_id = "123](https://evil.test)[";
    item.message.author_tag = "legacy author";

    const description = buildEvidencePayload(item).embeds[0].description;

    expect(description).toContain("Message sent by legacy author deleted in <#234567890123456789>");
    expect(description).not.toContain("evil.test");
    expect(description).not.toContain("discord.com/users/");
  });

  it("does not turn malformed legacy channel IDs into mention or Markdown injection", () => {
    const item = evidence();
    item.message.channel_id = "123> [admin](https://evil.test)";

    const description = buildEvidencePayload(item).embeds[0].description;

    expect(description).toContain("deleted in an unknown channel");
    expect(description).not.toContain("evil.test");
    expect(description).not.toContain("<#123>");
  });

  it("removes deprecated directional controls from every evidence presentation surface while preserving exact content", () => {
    const controls = "\u206a\u206b\u206c\u206d\u206e\u206f";
    const item = evidence(`content-before${controls}content-after`);
    item.message.author_tag = `author-before${controls}author-after`;
    item.message.matched_reasons = JSON.stringify([`reason-before${controls}reason-after`]);
    item.attachments[0].filename = `file-before${controls}file-after.txt`;

    const payload = buildEvidencePayload(item);
    expect(payload.embeds[0].author.name).not.toMatch(/[\u206a-\u206f]/u);
    expect(payload.embeds[0].description.split("\n", 1)[0]).not.toMatch(/[\u206a-\u206f]/u);
    expect(payload.embeds[0].description).not.toMatch(/[\u206a-\u206f]/u);
    expect(payload.embeds[0].fields[0].value).not.toMatch(/[\u206a-\u206f]/u);
    expect(payload.files.find((file) => file.description?.startsWith("Preserved attachment"))?.name)
      .not.toMatch(/[\u206a-\u206f]/u);
    expect(payload.files.find((file) => file.name === "deleted-message-m1.txt")?.attachment.toString("utf8"))
      .toBe(item.message.content);
  });

  it("neutralizes zero-width format controls without losing exact content", () => {
    const item = evidence("left\u200bright\u2060");
    item.message.author_tag = "ad\u200dmin\ufeff";
    const payload = buildEvidencePayload(item);

    expect(payload.embeds[0].author.name).toBe("ad min");
    expect(payload.embeds[0].description).not.toMatch(/[\u200b\u2060\ufeff]/u);
    expect(payload.files.find((file) => file.name === "deleted-message-m1.txt")?.attachment.toString("utf8"))
      .toBe(item.message.content);
  });

  it.each([
    ["combining grapheme joiner", "\u034f"],
    ["Hangul choseong filler", "\u115f"],
    ["Khmer vowel inherent AQ", "\u17b4"],
    ["reserved format control", "\u2065"],
    ["Hangul filler", "\u3164"],
    ["halfwidth Hangul filler", "\uffa0"],
    ["Egyptian hieroglyph format control", "\u{13430}"],
    ["shorthand format letter overlap", "\u{1bca0}"],
    ["musical symbol begin beam", "\u{1d173}"],
  ])("removes reproduced unsafe %s from every evidence surface and attaches exact content", (_name, unsafe) => {
    const content = `content-before${unsafe}content-after`;
    const item = evidence(content);
    item.message.message_id = `message-before${unsafe}message-after`;
    item.message.author_tag = `author-before${unsafe}author-after`;
    item.message.matched_reasons = JSON.stringify([`reason-before${unsafe}reason-after`]);
    item.attachments[0].filename = `file-before${unsafe}file-after.txt`;

    const payload = buildEvidencePayload(item);
    const presentation = [
      payload.embeds[0].author.name,
      payload.embeds[0].description,
      payload.embeds[0].fields[0].value,
      payload.embeds[0].footer.text,
      ...payload.files.map((file) => file.name),
    ].join("\n");

    expect(presentation).not.toContain(unsafe);
    const exact = payload.files.find((file) => file.description === "Full deleted message content");
    expect(exact?.attachment.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("preserves visible Unicode, combining marks, and deliberate emoji sequences without an exact-content attachment", () => {
    const safe = "Café हिन्दी e\u0301 👩\u200d💻 ❤️ 1️⃣";
    const item = evidence(safe);
    item.message.author_tag = safe;
    item.message.matched_reasons = JSON.stringify([safe]);
    item.message.message_id = `id-${safe}`;
    item.attachments[0].filename = `proof-${safe}.txt`;

    const payload = buildEvidencePayload(item);

    expect(payload.embeds[0].author.name).toBe(safe);
    expect(payload.embeds[0].description).toContain("👩\u200d💻 ❤️");
    expect(payload.embeds[0].fields[0].value).toContain("👩\u200d💻 ❤️");
    expect(payload.embeds[0].footer.text).toContain("👩\u200d💻 ❤️");
    expect(payload.files.some((file) => file.description === "Full deleted message content")).toBe(false);
    expect(payload.files[0].name).toBe(`proof-${safe}.txt`);
  });

  it("preserves contextual emoji sequences in path-safe filenames", () => {
    const item = evidence();
    const filename = "plain-🔥-zwj-👩\u200d💻-vs-❤️-keycap-1️⃣.txt";
    item.attachments[0].filename = filename;

    expect(buildEvidencePayload(item).files[0].name).toBe(filename);
  });

  it("truncates filenames at 200 complete Unicode code points", () => {
    const item = evidence();
    item.attachments[0].filename = `${"a".repeat(199)}🔥tail.txt`;

    const name = buildEvidencePayload(item).files[0].name;
    expect(name).toBe(`${"a".repeat(199)}🔥`);
    expect([...name]).toHaveLength(200);
    expect(name).not.toMatch(/[\ud800-\udfff]$/u);
  });

  it.each([
    ["combining marks", "a\u0301".repeat(150)],
    ["regional-indicator flags", "🇺🇸".repeat(150)],
    ["ZWJ emoji", "👩\u200d💻".repeat(100)],
  ])("caps %s filenames at 200 Unicode code points", (_name, filename) => {
    const item = evidence();
    item.attachments[0].filename = `${filename}.txt`;

    const name = buildEvidencePayload(item).files[0].name;

    expect([...name].length).toBeLessThanOrEqual(200);
  });

  it("retains evidence when the first grapheme exceeds a UTF-16 surface limit", () => {
    const oversizedGrapheme = `a${"\u0301".repeat(600)}`;
    const item = evidence();
    item.message.author_tag = oversizedGrapheme;
    item.message.matched_reasons = JSON.stringify([oversizedGrapheme]);
    item.message.message_id = oversizedGrapheme;

    const embed = buildEvidencePayload(item).embeds[0];

    expect(embed.author.name).not.toBe("");
    expect(embed.author.name.length).toBeLessThanOrEqual(128);
    expect(embed.fields[0].value).not.toBe("");
    expect(embed.fields[0].value.length).toBeLessThanOrEqual(480);
    expect(embed.footer.text).not.toBe("Message ID: ");
    expect(embed.footer.text.length).toBeLessThanOrEqual(256);
  });

  describe("dangling contextual ZWJ truncation boundary", () => {
    // U+1F469 WOMAN, U+200D ZWJ, U+1F4BB LAPTOP: one grapheme cluster (👩‍💻).
    // Padding each surface to exactly (limit - 3) forces a naive per-code-point
    // truncation to admit the cluster's first code point plus the joining ZWJ
    // while rejecting the final code point, leaving a dangling invisible ZWJ.
    const CLUSTER = "\u{1F469}\u200d\u{1F4BB}";

    const surfaces: Array<{
      name: string;
      pad: number;
      build: (item: StoredEvidence, padded: string) => void;
      extract: (payload: EvidencePayload) => string;
    }> = [
      {
        name: "author name",
        pad: 125, // limit 128
        build: (item, padded) => { item.message.author_tag = padded; },
        extract: (payload) => payload.embeds[0].author.name,
      },
      {
        name: "matched-reason field",
        pad: 477, // limit 480
        build: (item, padded) => { item.message.matched_reasons = JSON.stringify([padded]); },
        extract: (payload) => payload.embeds[0].fields[0].value,
      },
      {
        name: "message-ID footer",
        pad: 241, // limit 244
        build: (item, padded) => { item.message.message_id = padded; },
        extract: (payload) => payload.embeds[0].footer.text,
      },
      {
        name: "attachment filename",
        pad: 198, // limit 200 code points
        build: (item, padded) => { item.attachments[0].filename = `${padded}.txt`; },
        extract: (payload) => payload.files[0].name,
      },
    ];

    it.each(surfaces.map((surface) => [surface.name, surface] as const))(
      "never leaves a dangling ZWJ on %s when a valid emoji/ZWJ cluster is cut at the length boundary",
      (_name, surface) => {
        const item = evidence();
        const padded = `${"a".repeat(surface.pad)}${CLUSTER}tail`;
        surface.build(item, padded);

        const payload = buildEvidencePayload(item);
        const value = surface.extract(payload);

        expect(value).not.toMatch(/\u200d$/u);
        expect(value).not.toMatch(/[\ufe0e\ufe0f]$/u);
      },
    );
  });

  it("removes every runtime-supported default-ignorable, format, and control code point from fallback and evidence surfaces", () => {
    const unsafeProperty = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\p{Cf}\u2028\u2029\ufff9-\ufffb]/u;
    const unsafeCodePoints: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const character = String.fromCodePoint(codePoint);
      if (unsafeProperty.test(character)) unsafeCodePoints.push(character);
    }

    expect(unsafeCodePoints.length).toBeGreaterThan(4000);
    for (const unsafe of unsafeCodePoints) {
      const content = `content${unsafe}body`;
      const item = evidence(content);
      item.message.author_tag = unsafe;
      item.message.author_id = `fallback${unsafe}author`;
      item.message.channel_id = `fallback${unsafe}channel`;
      item.message.message_id = `message${unsafe}id`;
      item.message.matched_reasons = JSON.stringify([`reason${unsafe}text`]);
      item.attachments[0].filename = `file${unsafe}name.txt`;

      const payload = buildEvidencePayload(item);
      const nonContentPresentation = [
        payload.embeds[0].author.name,
        payload.embeds[0].fields[0].value,
        payload.embeds[0].footer.text,
        ...payload.files.map((file) => file.name),
      ].join("|");

      expect(nonContentPresentation).not.toContain(unsafe);
      expect(payload.embeds[0].description).toContain("deleted in an unknown channel");
      const exact = payload.files.find((file) => file.description === "Full deleted message content");
      if (["\t", "\n"].includes(unsafe)) {
        expect(exact).toBeUndefined();
      } else {
        expect(payload.embeds[0].description).not.toContain(unsafe);
        expect(exact?.attachment.equals(Buffer.from(content, "utf8"))).toBe(true);
      }
    }
  }, 20_000);

  it("bounds attacker-controlled author labels within Discord embed limits", () => {
    const item = evidence("hello");
    item.message.author_id = "123456789012345678";
    item.message.author_tag = "[".repeat(10_000);
    const payload = buildEvidencePayload(item);

    expect(payload.embeds[0].author.name.length).toBeLessThanOrEqual(256);
    expect(payload.embeds[0].description.length).toBeLessThanOrEqual(4096);
    expect(payload.embeds[0].description).toContain("<@123456789012345678> (`123456789012345678`)");
  });

  it("bounds and neutralizes malformed legacy message IDs in embed footers", () => {
    const item = evidence();
    item.message.message_id = `${"x".repeat(3000)}\u202e`;

    const footer = buildEvidencePayload(item).embeds[0].footer.text;

    expect(footer.length).toBeLessThanOrEqual(2048);
    expect(footer).not.toContain("\u202e");
  });

  it("keeps aggregate embed text within Discord's 6,000 UTF-16-unit limit", () => {
    const item = evidence("a".repeat(3500));
    item.message.author_tag = "a".repeat(1000);
    item.message.message_id = "m".repeat(3000);
    item.message.matched_reasons = JSON.stringify(["[".repeat(480)]);

    const embed = buildEvidencePayload(item).embeds[0];
    const total = embed.author.name.length + embed.description.length + embed.footer.text.length
      + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);

    expect(total).toBeLessThanOrEqual(6000);
  });

  it("escapes attacker-controlled Markdown while preserving trusted labels", () => {
    const item = evidence("# heading **bold** [link](https://evil.test) ||spoiler|| <@123> @everyone");
    item.message.author_tag = "**admin** `code` @here";
    item.message.matched_reasons = JSON.stringify(["keyword: **urgent**", "pattern: ||hide||"]);
    const payload = buildEvidencePayload(item);
    expect(payload.embeds[0].description).toContain("> \\# heading \\*\\*bold\\*\\* \\[link\\]\\(https://evil\\.test\\) \\|\\|spoiler\\|\\|");
    expect(payload.embeds[0].author.name).toContain("**admin** `code`");
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload.embeds[0].description).not.toContain("<@123>");
    expect(payload.embeds[0].description).not.toContain("@everyone");
    expect(payload.embeds[0].description).not.toContain("@here");
  });

  it("retains safely rendered match context in the evidence embed", () => {
    const item = evidence();
    item.message.matched_reasons = JSON.stringify(["keyword: **urgent**\nspoof", "pattern: @everyone"]);
    const embed = buildEvidencePayload(item).embeds[0];

    expect(embed.fields).toEqual([{ name: "Matched", value: "keyword: \\*\\*urgent\\*\\* spoof, pattern: @ everyone" }]);
  });

  it("renders deleted text prominently in the embed with an empty-text fallback", () => {
    const item = evidence("first line\nsecond **line** <@123>");
    const payload = buildEvidencePayload(item);

    expect(payload.content).toBe("");
    expect(payload.embeds[0].description).toContain("> first line\n> second \\*\\*line\\*\\* \\< @123\\>");

    item.message.content = "";
    expect(buildEvidencePayload(item).embeds[0].description).toContain("> *(no text content)*");
  });

  it("renders whitespace-only text visibly while preserving its exact bytes", () => {
    const content = " \t\n  \r\n";
    const payload = buildEvidencePayload(evidence(content));

    expect(payload.embeds[0].description).toContain("> *(no text content)*");
    const exact = payload.files.find((file) => file.name === "deleted-message-m1.txt");
    expect(exact?.attachment.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("renders control-character payloads safely while attaching their exact bytes", () => {
    const content = "before\u0000\u202eafter\n<@123>";
    const payload = buildEvidencePayload(evidence(content));

    expect(payload.embeds[0].description).not.toMatch(/[\u0000\u202e]/u);
    const exact = payload.files.find((file) => file.name === "deleted-message-m1.txt");
    expect(exact?.attachment.equals(Buffer.from(content, "utf8"))).toBe(true);
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it("keeps Unicode line and paragraph separators inside the quote while attaching their exact bytes", () => {
    const content = "before\u2028spoofed boundary\u2029after";
    const payload = buildEvidencePayload(evidence(content));

    expect(payload.embeds[0].description).not.toMatch(/[\u2028\u2029]/u);
    expect(payload.embeds[0].description).toContain("> before�spoofed boundary�after");
    const exact = payload.files.find((file) => file.name === "deleted-message-m1.txt");
    expect(exact?.attachment.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it.each([
    ["lone CR", "before\rafter", "> before�after"],
    ["CRLF", "before\r\nafter", "> before�\n> after"],
  ])("keeps %s content inside the quote and attaches its exact bytes", (_name, content, quoted) => {
    const payload = buildEvidencePayload(evidence(content));

    expect(payload.embeds[0].description).toContain(quoted);
    expect(payload.embeds[0].description).not.toContain("\r");
    const exact = payload.files.find((file) => file.name === "deleted-message-m1.txt");
    expect(exact?.attachment.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("removes every Unicode directional control from preserved filenames", () => {
    const item = evidence();
    const controls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    item.attachments[0].filename = `report${controls}cod.exe`;
    expect(buildEvidencePayload(item).files[0].name).toBe("reportcod.exe");
  });

  it("replaces C0 and C1 filename controls without changing evidence bytes", () => {
    const item = evidence();
    item.attachments[0].filename = "before\u0000\u0085after.txt";
    const file = buildEvidencePayload(item).files[0];
    expect(file.name).toBe("before__after.txt");
    expect(file.attachment.equals(Buffer.from("proof"))).toBe(true);
  });

  it("removes both POSIX and Windows path syntax from untrusted filenames and fallback identifiers", () => {
    const item = evidence("x".repeat(5000));
    item.message.message_id = "..\\secret";
    item.attachments[0].filename = "..\\windows\\secret.txt";

    const payload = buildEvidencePayload(item);

    expect(payload.files.every((file) => !/[\\/]/u.test(file.name))).toBe(true);
    expect(payload.files.every((file) => !file.name.includes(".."))).toBe(true);
  });

  it("sanitizes an attachment-ID fallback when the stored filename has no safe characters", () => {
    const item = evidence();
    item.attachments[0].filename = "\u034f";
    item.attachments[0].attachment_id = "..\\spoof\u{13430}/id";

    const file = buildEvidencePayload(item).files[0];

    expect(file.name).not.toMatch(/[\\/\p{Default_Ignorable_Code_Point}\p{Cf}]/u);
    expect(file.name).not.toContain("..");
    expect(file.name.length).toBeLessThanOrEqual(200);
    expect(file.attachment.equals(Buffer.from("proof"))).toBe(true);
  });

  it("attaches full long UTF-8 content and keeps the message concise", () => {
    const content = "🔥 <@123> ".repeat(700);
    const payload = buildEvidencePayload(evidence(content));
    expect(payload.content).toBe("");
    expect(payload.embeds[0].description).toContain("attached as **deleted-message-m1.txt**");
    expect(payload.embeds[0].description).toContain("<@123456789012345678> (`123456789012345678`)");
    const contentFile = payload.files.find((file) => file.name === "deleted-message-m1.txt");
    expect(contentFile?.attachment.toString("utf8")).toBe(content);
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it("caps the complete full-content attachment filename at 200 Unicode code points", () => {
    const item = evidence("x".repeat(5000));
    item.message.message_id = "m".repeat(300);

    const payload = buildEvidencePayload(item);
    const contentFile = payload.files.find((file) => file.description === "Full deleted message content");

    expect(contentFile?.name).toBeTruthy();
    expect([...(contentFile?.name ?? "")]).toHaveLength(200);
    expect(contentFile?.name).toMatch(/^deleted-message-.*\.txt$/u);
    expect(contentFile?.name).not.toMatch(/[\\/\u0000-\u001f\u007f-\u009f]/u);
    expect(payload.embeds[0].description).toContain(contentFile?.name);
  });

  it("strips Unicode line and paragraph separators from preserved filenames", () => {
    const item = evidence();
    item.attachments[0].filename = "before\u2028middle\u2029after.txt";
    expect(buildEvidencePayload(item).files[0].name).toBe("beforemiddleafter.txt");
  });

  it("strips soft hyphens, Mongolian vowel separator, and invisible math operators from presentation surfaces", () => {
    const item = evidence("body\u00adtext\u180emore\u2061end");
    item.message.author_tag = "auth\u00ador\u180ename\u2062tag";
    item.message.matched_reasons = JSON.stringify([`reason\u00ad\u180e\u2063\u2064marker`]);
    item.attachments[0].filename = "file\u00ad\u180e\u2061name.txt";

    const payload = buildEvidencePayload(item);

    expect(payload.embeds[0].author.name).not.toMatch(/[\u00ad\u180e\u2061-\u2064]/u);
    expect(payload.embeds[0].description).not.toMatch(/[\u00ad\u180e\u2061-\u2064]/u);
    expect(payload.embeds[0].fields[0].value).not.toMatch(/[\u00ad\u180e\u2061-\u2064]/u);
    expect(payload.files[0].name).not.toMatch(/[\u00ad\u180e\u2061-\u2064]/u);
  });

  it("strips interlinear annotation and Unicode tag block characters from presentation surfaces", () => {
    const item = evidence("body\ufff9anno\ufffbend\u{e0001}tagged\u{e007f}");
    item.message.author_tag = "auth\ufff9or\u{e0041}name";
    item.message.matched_reasons = JSON.stringify([`reason\ufff9\u{e0000}marker`]);
    item.attachments[0].filename = "file\ufff9\u{e0000}name.txt";

    const payload = buildEvidencePayload(item);

    expect(payload.embeds[0].author.name).not.toMatch(/[\ufff9-\ufffb\u{e0000}-\u{e007f}]/u);
    expect(payload.embeds[0].description).not.toMatch(/[\ufff9-\ufffb\u{e0000}-\u{e007f}]/u);
    expect(payload.embeds[0].fields[0].value).not.toMatch(/[\ufff9-\ufffb\u{e0000}-\u{e007f}]/u);
    expect(payload.files[0].name).not.toMatch(/[\ufff9-\ufffb\u{e0000}-\u{e007f}]/u);
  });

  it("escapes Markdown delimiters in legacy fallback filenames", () => {
    const item = evidence("x".repeat(5000));
    item.message.message_id = "legacy**name";

    const payload = buildEvidencePayload(item);

    expect(payload.embeds[0].description)
      .toContain("attached as **deleted-message-legacy\\*\\*name.txt**.");
    expect(payload.files.find((file) => file.description === "Full deleted message content")?.name)
      .toBe("deleted-message-legacy**name.txt");
  });
});

describe("deliverEvidence", () => {
  function setup(reviewChannelId: string | null = "review") {
    const item = evidence();
    const store = {
      getEvidence: vi.fn(() => item),
      getConfig: vi.fn(() => ({ review_channel_id: reviewChannelId })),
      removeClaimed: vi.fn(() => true),
      renewDeliveryClaim: vi.fn<(messageId: string, token: string, now: Date, leaseMs: number) => boolean>(() => true),
      isClaimDeliverable: vi.fn(() => true),
      advanceDeliveryBatch: vi.fn(() => true),
      scheduleRetry: vi.fn(),
    };
    const send = vi.fn<(payload: unknown) => Promise<unknown>>(async () => undefined);
    const fetchChannel = vi.fn<() => Promise<{ isSendable: () => boolean; send: typeof send } | null>>(async () => ({ isSendable: () => true, send }));
    const log = vi.fn();
    return { store, send, fetchChannel, log };
  }

  it("removes evidence only after Discord delivery succeeds", async () => {
    const ctx = setup();
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [], repliedUser: false } }));
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-a");
    expect(ctx.send.mock.invocationCallOrder[0]).toBeLessThan(ctx.store.removeClaimed.mock.invocationCallOrder[0]);
  });

  it("retains evidence when no review channel is configured", async () => {
    const ctx = setup(null);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.fetchChannel).not.toHaveBeenCalled();
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
  });

  it("retains evidence when the review channel is unavailable or not sendable", async () => {
    const ctx = setup();
    ctx.fetchChannel.mockResolvedValueOnce(null);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
  });

  it("retains evidence and logs when channel fetch or send fails", async () => {
    const ctx = setup();
    ctx.send.mockRejectedValueOnce(new Error("missing permissions"));
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("evidence_delivery_failed", expect.objectContaining({ error: "missing permissions" }));
    expect(ctx.store.scheduleRetry).toHaveBeenCalledWith("m1", expect.any(Error), expect.any(Date), { claimToken: "claim-a" });
  });

  it("keeps a blocked multi-batch send leased so a replacement cannot claim it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const directory = mkdtempSync(join(tmpdir(), "evidence-lease-"));
    const path = join(directory, "messages.db");
    const first = new MessageStore(path, 336);
    const second = new MessageStore(path, 336);
    try {
      const item = evidence("x".repeat(3000));
      item.attachments = Array.from({ length: 11 }, (_, index) => ({
        attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
        size: 1, source_url: "url", bytes: Buffer.from("x"),
      }));
      first.save(item.message, item.attachments);
      first.markDeleted("m1", new Date());
      first.setReviewChannel("g1", "review");
      expect(first.claimDelivery("m1", "claim-a", new Date(), 100)).toBe(true);

      let releaseFirstSend!: () => void;
      const send = vi.fn<(payload: unknown) => Promise<unknown>>()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstSend = resolve; }))
        .mockResolvedValue(undefined);
      const fetchChannel = async () => ({ isSendable: () => true, send });
      const delivery = deliverEvidence("g1", "m1", "claim-a", first, fetchChannel, undefined, {
        leaseMs: 100,
        heartbeatMs: 25,
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(second.claimDelivery("m1", "claim-b", new Date(), 100)).toBe(false);

      releaseFirstSend();
      await expect(delivery).resolves.toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("rejects a stale token before a later batch after ownership changes", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    ctx.store.renewDeliveryClaim.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await expect(deliverEvidence("g1", "m1", "stale-token", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "stale-token", 1);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.scheduleRetry).toHaveBeenCalledWith("m1", expect.any(Error), expect.any(Date), { claimToken: "stale-token" });
  });

  it("removes only after every payload batch succeeds and retries partial failure", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    ctx.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("batch two failed"));
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.send).toHaveBeenCalledTimes(2);
    expect(ctx.send.mock.calls.every(([payload]) => JSON.stringify(payload).includes("<@123456789012345678> (`123456789012345678`)"))).toBe(true);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "claim-a", 1);
    expect(ctx.store.scheduleRetry).toHaveBeenCalled();
  });

  it("resumes a v0.2 text-file batch without omitting or duplicating attachments after upgrade", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    Object.assign(item.message, { delivery_batch_index: 1, delivery_batch_plan_version: 1 });
    item.attachments = Array.from({ length: 10 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from(String(index)),
    }));
    ctx.store.getEvidence.mockReturnValue(item);

    await expect(deliverEvidence("g1", "m1", "claim-upgrade", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect((ctx.send.mock.calls[0][0] as { files: Array<{ name: string }> }).files.map((file) => file.name)).toEqual(["9.txt"]);
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "claim-upgrade", 2);
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-upgrade");
  });

  it("appends newly required exact default-ignorable content without replaying a completed v0.2 attachment batch", async () => {
    const ctx = setup();
    const item = evidence("before\u034fafter");
    Object.assign(item.message, { delivery_batch_index: 1, delivery_batch_plan_version: 1 });
    item.attachments = Array.from({ length: 10 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from(String(index)),
    }));
    ctx.store.getEvidence.mockReturnValue(item);

    await expect(deliverEvidence("g1", "m1", "claim-control", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const sent = (ctx.send.mock.calls[0][0] as { files: Array<{ name: string; attachment: Buffer }> }).files;
    expect(sent.map((file) => file.name)).toEqual(["deleted-message-m1.txt"]);
    expect(sent[0].attachment.toString("utf8")).toBe(item.message.content);
  });

  it("does not silently drop a newly required attachment for 0-9 legacy attachments after batch 1 completed", async () => {
    const ctx = setup();
    const item = evidence("before\u206aafter");
    Object.assign(item.message, { delivery_batch_index: 1, delivery_batch_plan_version: 1 });
    item.attachments = Array.from({ length: 9 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from(String(index)),
    }));
    ctx.store.getEvidence.mockReturnValue(item);

    await expect(deliverEvidence("g1", "m1", "claim-nine", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const sent = (ctx.send.mock.calls[0][0] as { files: Array<{ name: string; attachment: Buffer }> }).files;
    expect(sent.map((file) => file.name)).toEqual(["deleted-message-m1.txt"]);
    expect(sent[0].attachment.toString("utf8")).toBe(item.message.content);
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-nine");
  });

  it("does not silently drop a newly required attachment for 11-19 legacy attachments after batch 2 completed", async () => {
    const ctx = setup();
    const item = evidence("before\u206aafter");
    Object.assign(item.message, { delivery_batch_index: 2, delivery_batch_plan_version: 1 });
    item.attachments = Array.from({ length: 15 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from(String(index)),
    }));
    ctx.store.getEvidence.mockReturnValue(item);

    await expect(deliverEvidence("g1", "m1", "claim-fifteen", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const sent = (ctx.send.mock.calls[0][0] as { files: Array<{ name: string; attachment: Buffer }> }).files;
    expect(sent.map((file) => file.name)).toEqual(["deleted-message-m1.txt"]);
    expect(sent[0].attachment.toString("utf8")).toBe(item.message.content);
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-fifteen");
  });

  it("does not silently drop a newly required attachment for exactly 20 legacy attachments after batch 2 completed", async () => {
    const ctx = setup();
    const item = evidence("before\u206aafter");
    Object.assign(item.message, { delivery_batch_index: 2, delivery_batch_plan_version: 1 });
    item.attachments = Array.from({ length: 20 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from(String(index)),
    }));
    ctx.store.getEvidence.mockReturnValue(item);

    await expect(deliverEvidence("g1", "m1", "claim-twenty", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const sent = (ctx.send.mock.calls[0][0] as { files: Array<{ name: string; attachment: Buffer }> }).files;
    expect(sent.map((file) => file.name)).toEqual(["deleted-message-m1.txt"]);
    expect(sent[0].attachment.toString("utf8")).toBe(item.message.content);
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-twenty");
  });

  it("sends the newly required attachment exactly once when a mid-batch delivery resumes after a claim renewal restart", async () => {
    const ctx = setup();
    const item = evidence("before\u206aafter");
    Object.assign(item.message, { delivery_batch_index: 1, delivery_batch_plan_version: 1 });
    item.attachments = Array.from({ length: 10 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from(String(index)),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    // Simulate a resumed worker: an earlier process already renewed the claim once
    // before restarting, and this run picks up where the (still-pending) batch left off.
    ctx.store.renewDeliveryClaim.mockReturnValueOnce(true).mockReturnValue(true);

    await expect(deliverEvidence("g1", "m1", "claim-resume", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const sent = (ctx.send.mock.calls[0][0] as { files: Array<{ name: string; attachment: Buffer }> }).files;
    expect(sent.map((file) => file.name)).toEqual(["deleted-message-m1.txt"]);
    expect(sent[0].attachment.toString("utf8")).toBe(item.message.content);
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "claim-resume", 2);
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-resume");
  });

  it("resumes after the last durably completed payload batch", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.message.delivery_batch_index = 1;
    item.message.delivery_batch_plan_version = 2;
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    await expect(deliverEvidence("g1", "m1", "claim-b", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(true);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect((ctx.send.mock.calls[0][0] as { files: Array<{ name: string }> }).files.map((file) => file.name)).toEqual(["10.txt"]);
    expect(JSON.stringify(ctx.send.mock.calls[0][0])).toContain("<@123456789012345678> (`123456789012345678`)");
    expect(ctx.store.advanceDeliveryBatch).toHaveBeenCalledWith("m1", "claim-b", 2);
    expect(ctx.store.removeClaimed).toHaveBeenCalledWith("m1", "claim-b");
  });

  it("aborts before any irreversible send once retention/ownership is lost", async () => {
    const ctx = setup();
    ctx.store.isClaimDeliverable.mockReturnValue(false);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.scheduleRetry).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("evidence_delivery_fenced", expect.objectContaining({ guildId: "g1", messageId: "m1" }));
  });

  it("aborts mid-batch and does not log success once a fence check fails before send", async () => {
    const ctx = setup();
    const item = evidence("x".repeat(3000));
    item.attachments = Array.from({ length: 11 }, (_, index) => ({
      attachment_id: `a${index}`, message_id: "m1", filename: `${index}.txt`, content_type: "text/plain",
      size: 1, source_url: "url", bytes: Buffer.from("x"),
    }));
    ctx.store.getEvidence.mockReturnValue(item);
    ctx.store.isClaimDeliverable.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(deliverEvidence("g1", "m1", "claim-a", ctx.store, ctx.fetchChannel, ctx.log)).resolves.toBe(false);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.store.removeClaimed).not.toHaveBeenCalled();
    expect(ctx.store.scheduleRetry).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("evidence_delivery_fenced", expect.objectContaining({ guildId: "g1", messageId: "m1" }));
  });
});
