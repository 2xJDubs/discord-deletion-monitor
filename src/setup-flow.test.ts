import { describe, expect, it, vi } from "vitest";
import { MonitorSetupFlow, SETUP_CUSTOM_IDS, renderSetupView } from "./setup-flow.js";

function store() {
  return {
    listRules: vi.fn(() => ["old-channel"]),
    applySetup: vi.fn(),
  };
}

describe("guided monitor setup", () => {
  it("binds components to the newest collision-resistant flow and rejects stale overlapping setup messages", () => {
    const ids = ["flow-old", "flow-new"];
    const flow = new MonitorSetupFlow(store(), () => 1_000, 60_000, () => ids.shift()!);
    const oldView = flow.begin("guild", "admin");
    const newView = flow.begin("guild", "admin");

    expect(flow.select("guild", "admin", oldView.flowId, ["stale-channel"], [])).toEqual({ kind: "expired" });
    expect(flow.select("guild", "admin", newView.flowId, ["current-channel"], [])).toMatchObject({
      kind: "confirm", flowId: "flow-new", selectedChannelIds: ["current-channel"],
    });
    const customIds = renderSetupView(newView).components[0].toJSON().components
      .map((component) => "custom_id" in component ? component.custom_id : "");
    expect(customIds).toEqual([`${SETUP_CUSTOM_IDS.channels}:flow-new`]);
    expect(customIds.every((id) => id.length <= 100)).toBe(true);
  });

  it("invalidates an older setup when another administrator starts one for the same server", () => {
    const state = store();
    const ids = ["flow-old", "flow-new"];
    const flow = new MonitorSetupFlow(state, () => 1_000, 60_000, () => ids.shift()!);
    const oldView = flow.begin("guild", "admin-one");
    const newView = flow.begin("guild", "admin-two");

    expect(flow.select("guild", "admin-one", oldView.flowId, ["stale-channel"], [])).toEqual({ kind: "expired" });
    expect(flow.select("guild", "admin-two", newView.flowId, ["current-channel"], [])).toMatchObject({
      kind: "confirm", flowId: "flow-new", selectedChannelIds: ["current-channel"],
    });
    expect(state.applySetup).not.toHaveBeenCalled();
  });

  it("commits the exact channel snapshot that passed permissions despite a concurrent session mutation", () => {
    const state = store();
    const flow = new MonitorSetupFlow(state, () => 1_000, 60_000, () => "flow-id");
    const begun = flow.begin("guild", "admin");
    flow.select("guild", "admin", begun.flowId, ["checked-channel"], []);
    const checkedSnapshot = flow.selectedChannels("guild", "admin", begun.flowId)!;
    flow.select("guild", "admin", begun.flowId, ["later-channel"], []);

    const complete = flow.confirm("guild", "admin", begun.flowId, checkedSnapshot, []);

    expect(complete).toMatchObject({ kind: "complete", selectedChannelIds: ["checked-channel"] });
    expect(state.applySetup).toHaveBeenCalledWith("guild", ["checked-channel"]);
  });

  it("asks for monitored channels and preserves current choices as defaults", () => {
    const flow = new MonitorSetupFlow(store(), () => 1_000, 60_000, () => "flow-id");
    const view = flow.begin("guild", "admin");
    expect(view).toEqual({ kind: "select", flowId: "flow-id", selectedChannelIds: ["old-channel"] });
    const payload = renderSetupView(view);
    expect(payload.content).toContain("Select the channels to monitor");
    const menu = payload.components[0].toJSON().components[0];
    expect(menu).toMatchObject({
      custom_id: `${SETUP_CUSTOM_IDS.channels}:flow-id`,
      min_values: 1,
      max_values: 25,
      default_values: [{ id: "old-channel", type: "channel" }],
    });
  });

  it("asks for View Channel access and rechecks before confirmation", () => {
    const state = store();
    const flow = new MonitorSetupFlow(state, () => 1_000, 60_000, () => "flow-id");
    const begun = flow.begin("guild", "admin");
    const blocked = flow.select("guild", "admin", begun.flowId, ["visible", "hidden"], ["hidden"]);
    expect(blocked).toEqual({ kind: "permissions", flowId: "flow-id", selectedChannelIds: ["visible", "hidden"], inaccessibleChannelIds: ["hidden"] });
    const payload = renderSetupView(blocked);
    expect(payload.content).toContain("<#hidden>");
    expect(payload.content).toContain("View Channel");
    expect(payload.components[0].toJSON().components.map((item) => "custom_id" in item ? item.custom_id : null)).toContain(`${SETUP_CUSTOM_IDS.recheck}:flow-id`);

    const selected = flow.selectedChannels("guild", "admin", begun.flowId)!;
    const confirmation = flow.recheck("guild", "admin", begun.flowId, selected, []);
    expect(confirmation).toEqual({ kind: "confirm", flowId: "flow-id", selectedChannelIds: ["visible", "hidden"] });
    expect(state.applySetup).not.toHaveBeenCalled();
  });

  it("rechecks permissions at confirmation and replaces only after approval", () => {
    const state = store();
    const flow = new MonitorSetupFlow(state, () => 1_000, 60_000, () => "flow-id");
    const begun = flow.begin("guild", "admin");
    flow.select("guild", "admin", begun.flowId, ["channel-b", "channel-a"], []);
    const selected = flow.selectedChannels("guild", "admin", begun.flowId)!;

    const changed = flow.confirm("guild", "admin", begun.flowId, selected, ["channel-b"]);
    expect(changed.kind).toBe("permissions");
    expect(state.applySetup).not.toHaveBeenCalled();

    const complete = flow.confirm("guild", "admin", begun.flowId, selected, []);
    expect(complete).toEqual({ kind: "complete", selectedChannelIds: ["channel-b", "channel-a"] });
    expect(state.applySetup).toHaveBeenCalledWith("guild", ["channel-b", "channel-a"]);
  });

  it("rejects empty, oversized, expired, and other-user setup interactions", () => {
    let now = 1_000;
    const flow = new MonitorSetupFlow(store(), () => now, 60_000, () => "flow-id");
    const begun = flow.begin("guild", "admin");
    expect(flow.select("guild", "admin", begun.flowId, [], [])).toEqual({ kind: "invalid", reason: "Select between 1 and 25 channels." });
    expect(flow.select("guild", "admin", begun.flowId, Array.from({ length: 26 }, (_, index) => `c${index}`), [])).toEqual({ kind: "invalid", reason: "Select between 1 and 25 channels." });
    expect(flow.recheck("guild", "other", begun.flowId, [], [])).toEqual({ kind: "expired" });
    now = 61_001;
    expect(flow.recheck("guild", "admin", begun.flowId, [], [])).toEqual({ kind: "expired" });
  });

  it("cancels without replacing channel rules", () => {
    const state = store();
    const flow = new MonitorSetupFlow(state, Date.now, 60_000, () => "flow-id");
    const begun = flow.begin("guild", "admin");
    expect(flow.cancel("guild", "admin", begun.flowId)).toEqual({ kind: "cancelled" });
    expect(state.applySetup).not.toHaveBeenCalled();
    expect(flow.recheck("guild", "admin", begun.flowId, [], [])).toEqual({ kind: "expired" });
  });
});
