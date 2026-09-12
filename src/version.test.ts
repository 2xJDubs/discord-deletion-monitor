import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release metadata", () => {
  it("reports version 0.3.0 from the package manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe("0.3.0");
  });
});
