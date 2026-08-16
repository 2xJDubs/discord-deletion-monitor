import { describe, expect, it } from "vitest";
import { detectReasons, findUrls, normalizeDomain } from "./detector.js";

describe("detector", () => {
  it("detects links, keywords, subdomains, and enabled built-in patterns without duplicates", () => {
    expect(detectReasons(
      "URGENT payment at https://pay.example.com/path and https://pay.example.com/again",
      ["urgent", "URGENT"],
      ["example.com"],
      ["payment"],
    )).toEqual([
      "link (2)",
      "keyword: urgent",
      "domain: example.com",
      "pattern: payment",
    ]);
  });

  it("does not include sentence punctuation in detected URLs", () => {
    expect(findUrls("See https://example.com/path, then www.test.dev!"))
      .toEqual(["https://example.com/path", "www.test.dev"]);
  });

  it("normalizes protocol, www, paths, case, and trailing DNS dots", () => {
    expect(normalizeDomain(" HTTPS://WWW.Example.COM./path?q=1 ")).toBe("example.com");
  });

  it("ignores unknown pattern names", () => {
    expect(detectReasons("plain text", [], [], ["not-real"])).toEqual([]);
  });
});
