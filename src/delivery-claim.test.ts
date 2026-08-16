import { describe, expect, it, vi } from "vitest";
import { deliverWithClaim } from "./delivery-claim.js";

describe("deliverWithClaim", () => {
  it("does not deliver when another worker owns the lease", async () => {
    const claimDelivery = vi.fn(() => false);
    const deliver = vi.fn(async () => true);

    await expect(deliverWithClaim("g1", "m1", { claimDelivery }, deliver, {
      now: () => new Date("2026-01-01T00:00:00Z"),
      token: () => "claim-a",
      leaseMs: 300_000,
    })).resolves.toBe(false);

    expect(claimDelivery).toHaveBeenCalledWith("m1", "claim-a", new Date("2026-01-01T00:00:00Z"), 300_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("passes the acquired lease token through delivery", async () => {
    const claimDelivery = vi.fn(() => true);
    const deliver = vi.fn(async () => true);

    await expect(deliverWithClaim("g1", "m1", { claimDelivery }, deliver, {
      now: () => new Date("2026-01-01T00:00:00Z"),
      token: () => "claim-b",
      leaseMs: 300_000,
    })).resolves.toBe(true);

    expect(deliver).toHaveBeenCalledWith("g1", "m1", "claim-b");
  });
});
