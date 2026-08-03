import { describe, expect, it } from "vitest";

import {
  createConsoleBusyController,
  mergeConsoleBusyReaders,
} from "../../../apps/console/composables/console-busy-controller";

describe("console busy controller", () => {
  it("tracks each operation under its own key", () => {
    const busy = createConsoleBusyController();

    expect(busy.isAnyBusy.value).toBe(false);
    expect(busy.isBusy("grant:create")).toBe(false);

    busy.setBusy("grant:create");

    expect(busy.isBusy("grant:create")).toBe(true);
    expect(busy.isBusy("grant:other")).toBe(false);
    expect(busy.isAnyBusy.value).toBe(true);
  });

  it("keeps concurrent operations independent so neither masks the other", () => {
    const busy = createConsoleBusyController();

    busy.setBusy("ws:asset-submit");
    busy.setBusy("ws:asset-backfill");

    expect(busy.isBusy("ws:asset-submit")).toBe(true);
    expect(busy.isBusy("ws:asset-backfill")).toBe(true);
  });

  it("clears only the requested key and never a peer that is still running", () => {
    const busy = createConsoleBusyController();

    busy.setBusy("grant:create");
    busy.setBusy("grant:rotate");
    busy.clearBusy("grant:create");

    // The finished operation must not re-enable the one still in flight:
    // for a governed operation that would be a double-submit hazard.
    expect(busy.isBusy("grant:create")).toBe(false);
    expect(busy.isBusy("grant:rotate")).toBe(true);
    expect(busy.isAnyBusy.value).toBe(true);

    busy.clearBusy("grant:rotate");
    expect(busy.isAnyBusy.value).toBe(false);
  });

  it("treats repeated set and unknown clear as no-ops", () => {
    const busy = createConsoleBusyController();

    busy.setBusy("settings");
    busy.setBusy("settings");
    busy.clearBusy("never-started");
    expect(busy.isBusy("settings")).toBe(true);

    busy.clearBusy("settings");
    expect(busy.isBusy("settings")).toBe(false);

    busy.setBusy("");
    expect(busy.isAnyBusy.value).toBe(false);
  });

  it("scopes namespace queries by prefix", () => {
    const busy = createConsoleBusyController();

    busy.setBusy("ws:checkpoint-restore");

    expect(busy.isBusyPrefix("ws:")).toBe(true);
    expect(busy.isBusyPrefix("grant:")).toBe(false);
  });

  it("releases the key after withBusy resolves", async () => {
    const busy = createConsoleBusyController();

    const result = await busy.withBusy("ws:load", async () => {
      expect(busy.isBusy("ws:load")).toBe(true);
      return "loaded";
    });

    expect(result).toBe("loaded");
    expect(busy.isBusy("ws:load")).toBe(false);
  });

  it("releases the key when withBusy rejects", async () => {
    const busy = createConsoleBusyController();

    await expect(
      busy.withBusy("ws:load", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");

    expect(busy.isBusy("ws:load")).toBe(false);
    expect(busy.isAnyBusy.value).toBe(false);
  });

  it("reflects local and shell operations through a merged reader", () => {
    const local = createConsoleBusyController();
    const shell = createConsoleBusyController();
    const merged = mergeConsoleBusyReaders(local, shell);

    expect(merged.isAnyBusy.value).toBe(false);

    local.setBusy("ws:create");
    shell.setBusy("settings");

    expect(merged.isBusy("ws:create")).toBe(true);
    expect(merged.isBusy("settings")).toBe(true);
    expect(merged.isBusyPrefix("ws:")).toBe(true);
    expect(merged.isAnyBusy.value).toBe(true);

    local.clearBusy("ws:create");
    expect(merged.isBusy("ws:create")).toBe(false);
    expect(merged.isBusy("settings")).toBe(true);
  });
});
